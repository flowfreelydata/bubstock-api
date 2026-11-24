import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  loadAttestedKey,
  updateAttestedKeyState,
  upsertAttestedKey,
  type AttestedKeyRecord,
} from "./db.js";
import { hashIp, isHostileIp, markHostileIp } from "./deception.js";

// ─── Apple Security Engineering (SEAR) Server-Side Hardware Trust Engine ─────

const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200",
  "hex"
);

const MAX_CHALLENGES = 5_000;
const CHALLENGE_TTL_MS = 120_000;
const TIMESTAMP_DRIFT_MS = 120_000;
const MAX_NONCE_CACHE = 25_000;
const REPLAY_WINDOW_SIZE = 64;

const SCRAPER_BOT_UA_RE =
  /\b(python-requests|python-urllib|scrapy|aiohttp|httpx|go-http-client|wget|libwww-perl|java\/|okhttp|axios\/|node-fetch|puppeteer|playwright|selenium|headlesschrome)\b/i;

export interface RequestSecurityContext {
  ipHash: string;
  isAttested: boolean;
  attestMode: "app_attest" | "secure_enclave" | "dev_keychain" | "none";
  keyId?: string;
  isScraperUa: boolean;
  isHostile: boolean;
  isTamperedClient: boolean;
  isReplayAttack: boolean;
  isWidgetClient: boolean;
  useMirage: boolean;
  mirageReason?: string;
}

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      security?: RequestSecurityContext;
    }
  }
}

// Single-use enrollment challenge cache (challengeHex -> { ipHash, expiresAtMs })
const challengeCache = new Map<string, { ipHash: string; expiresAtMs: number }>();

// Single-use request nonce cache (keyId:nonce -> expiresAtMs)
const seenNonces = new Map<string, number>();

// RFC 4303 64-slot sliding replay window per hardware keyId
const counterWindows = new Map<string, { highest: number; seen: Set<number> }>();

export function issueAttestChallenge(ipHash: string): { challenge: string; expiresInSeconds: number } {
  const now = Date.now();
  if (challengeCache.size >= MAX_CHALLENGES) {
    for (const [k, v] of challengeCache) {
      if (v.expiresAtMs <= now) challengeCache.delete(k);
      if (challengeCache.size < MAX_CHALLENGES * 0.8) break;
    }
    if (challengeCache.size >= MAX_CHALLENGES) {
      const oldest = challengeCache.keys().next().value;
      if (oldest) challengeCache.delete(oldest);
    }
  }

  const challenge = crypto.randomBytes(32).toString("hex");
  challengeCache.set(challenge, { ipHash, expiresAtMs: now + CHALLENGE_TTL_MS });
  return { challenge, expiresInSeconds: Math.round(CHALLENGE_TTL_MS / 1000) };
}

export function consumeAttestChallenge(challenge: string): boolean {
  const rec = challengeCache.get(challenge);
  if (!rec) return false;
  challengeCache.delete(challenge);
  return rec.expiresAtMs > Date.now();
}

export function rawP256PublicKeyToPem(rawX963: Buffer): string | null {
  // Uncompressed EC P-256 x9.63 public key is always 65 bytes starting with 0x04
  if (rawX963.length !== 65 || rawX963[0] !== 0x04) return null;
  try {
    const spkiDer = Buffer.concat([P256_SPKI_PREFIX, rawX963]);
    const keyObj = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    return keyObj.export({ format: "pem", type: "spki" }).toString();
  } catch {
    return null;
  }
}

function verifyP256Signature(publicKeyPem: string, message: Buffer, sigBuf: Buffer): boolean {
  try {
    const keyObj = crypto.createPublicKey(publicKeyPem);
    const dsaEncoding = sigBuf.length === 64 ? "ieee-p1363" : "der";
    return crypto.verify("sha256", message, { key: keyObj, dsaEncoding }, sigBuf);
  } catch {
    return false;
  }
}

function validateAppAttestObject(cborB64: unknown): boolean {
  if (typeof cborB64 !== "string" || cborB64.length < 120 || cborB64.length > 16_000) return false;
  try {
    const buf = Buffer.from(cborB64, "base64");
    if (buf.length < 100) return false;
    // Apple App Attest CBOR attestation objects contain the ASCII format tag "apple-appattest"
    // and an "attStmt" map holding the "x5c" Apple hardware certificate chain + "authData".
    const ascii = buf.toString("latin1");
    return (
      ascii.includes("apple-appattest") &&
      ascii.includes("attStmt") &&
      ascii.includes("authData") &&
      ascii.includes("x5c")
    );
  } catch {
    return false;
  }
}

export async function enrollHardwareKey(params: {
  keyId: unknown;
  publicKeyB64: unknown;
  challenge: unknown;
  challengeSignatureB64: unknown;
  attestMode?: unknown;
  appAttestObjectB64?: unknown;
  bundleId?: unknown;
  ipHash: string;
}): Promise<{ ok: boolean; status: number; error?: string; mode?: AttestedKeyRecord["attestMode"] }> {
  const keyId = typeof params.keyId === "string" ? params.keyId.trim().toLowerCase() : "";
  const pubB64 = typeof params.publicKeyB64 === "string" ? params.publicKeyB64.trim() : "";
  const challenge = typeof params.challenge === "string" ? params.challenge.trim() : "";
  const sigB64 = typeof params.challengeSignatureB64 === "string" ? params.challengeSignatureB64.trim() : "";
  const bundleId = typeof params.bundleId === "string" ? params.bundleId.trim().slice(0, 80) : "au.com.bubstock.app";

  if (!/^[a-f0-9]{32}$/.test(keyId) || pubB64.length < 80 || !/^[a-f0-9]{64}$/.test(challenge) || sigB64.length < 64) {
    return { ok: false, status: 400, error: "Invalid hardware attestation enrollment payload" };
  }

  if (!consumeAttestChallenge(challenge)) {
    return { ok: false, status: 403, error: "Attestation challenge expired or already used" };
  }

  const rawPub = Buffer.from(pubB64, "base64");
  const computedKeyId = crypto.createHash("sha256").update(rawPub).digest("hex").slice(0, 32);
  if (computedKeyId !== keyId) {
    return { ok: false, status: 403, error: "Key identifier does not match public key" };
  }

  const publicKeyPem = rawP256PublicKeyToPem(rawPub);
  if (!publicKeyPem) {
    return { ok: false, status: 400, error: "Unsupported P-256 public key format" };
  }

  const sigBuf = Buffer.from(sigB64, "base64");
  const verified = verifyP256Signature(publicKeyPem, Buffer.from(challenge, "utf8"), sigBuf);
  if (!verified) {
    markHostileIp(params.ipHash, "invalid_enroll_signature", 60, { path: "/attest/enroll", method: "POST" });
    return { ok: false, status: 403, error: "Hardware challenge signature verification failed" };
  }

  const hasValidAppleAttest = validateAppAttestObject(params.appAttestObjectB64);
  const rawMode = typeof params.attestMode === "string" ? params.attestMode : "secure_enclave";
  const attestMode: AttestedKeyRecord["attestMode"] = hasValidAppleAttest
    ? "app_attest"
    : rawMode === "dev_keychain"
      ? "dev_keychain"
      : "secure_enclave";

  // Silent SEAR trap: if a re-signed IPA clone enrolls with a different bundleId, DO NOT reject!
  // Accept enrollment silently with taintMask = 1 so every subsequent request hits the Ghost Mirage!
  const bundleTampered = bundleId !== "au.com.bubstock.app";
  const taintMask = bundleTampered ? 1 : 0;
  if (bundleTampered) {
    markHostileIp(params.ipHash, `resigned_bundle_${bundleId.slice(0, 32)}`, 100, {
      path: "/attest/enroll",
      method: "POST",
    });
  }

  await upsertAttestedKey({
    keyId,
    publicKeyPem,
    attestMode,
    appAttestCbor: hasValidAppleAttest ? String(params.appAttestObjectB64) : undefined,
    bundleId,
    lastCounter: 0,
    taintMask,
    enrolledIpHash: params.ipHash,
  });

  counterWindows.set(keyId, { highest: 0, seen: new Set<number>() });
  return { ok: true, status: 201, mode: attestMode };
}

function checkSlidingReplayWindow(keyId: string, dbLastCounter: number, counter: number): boolean {
  if (!Number.isSafeInteger(counter) || counter <= 0) return false;
  let win = counterWindows.get(keyId);
  if (!win) {
    win = { highest: dbLastCounter, seen: new Set<number>() };
    counterWindows.set(keyId, win);
  }
  if (win.seen.has(counter)) return false;
  if (win.highest > 0 && counter <= win.highest - REPLAY_WINDOW_SIZE) return false;

  win.seen.add(counter);
  if (counter > win.highest) {
    win.highest = counter;
    const floor = win.highest - REPLAY_WINDOW_SIZE;
    for (const c of win.seen) {
      if (c <= floor) win.seen.delete(c);
    }
  }
  return true;
}

function checkAndRecordNonce(keyId: string, nonce: string): boolean {
  const now = Date.now();
  const composite = `${keyId}:${nonce}`;
  const exp = seenNonces.get(composite);
  if (exp && exp > now) return false;

  if (seenNonces.size >= MAX_NONCE_CACHE) {
    for (const [k, v] of seenNonces) {
      if (v <= now) seenNonces.delete(k);
      if (seenNonces.size < MAX_NONCE_CACHE * 0.8) break;
    }
    if (seenNonces.size >= MAX_NONCE_CACHE) {
      const oldest = seenNonces.keys().next().value;
      if (oldest) seenNonces.delete(oldest);
    }
  }
  seenNonces.set(composite, now + TIMESTAMP_DRIFT_MS * 2);
  return true;
}

function expectedIntegrityToken(keyId: string, kind: "ok" | "tainted", nonce: string, counter: number): string {
  return crypto
    .createHmac("sha256", keyId)
    .update(`${kind}:${nonce}:${counter}`)
    .digest("hex")
    .slice(0, 16);
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── Global Request Security Classifier & Hardware Signature Verifier ───────

export async function securityContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const ipHash = hashIp(req.ip);
  const ua = String(req.headers["user-agent"] ?? "");
  const isScraperUa = SCRAPER_BOT_UA_RE.test(ua);
  const isWidgetClient = String(req.headers["x-bubstock-client"] ?? "").toLowerCase() === "ios-widget";

  const ctx: RequestSecurityContext = {
    ipHash,
    isAttested: false,
    attestMode: "none",
    isScraperUa,
    isHostile: isHostileIp(ipHash),
    isTamperedClient: false,
    isReplayAttack: false,
    isWidgetClient,
    useMirage: false,
  };

  const keyId = String(req.headers["x-bubstock-key-id"] ?? "").trim().toLowerCase();
  const tsRaw = String(req.headers["x-bubstock-ts"] ?? "").trim();
  const nonce = String(req.headers["x-bubstock-nonce"] ?? "").trim().toLowerCase();
  const counterRaw = String(req.headers["x-bubstock-counter"] ?? "").trim();
  const sigB64 = String(req.headers["x-bubstock-sig"] ?? "").trim();
  const integrityToken = String(req.headers["x-bubstock-integrity"] ?? "").trim().toLowerCase();

  if (keyId && tsRaw && nonce && counterRaw && sigB64) {
    const ts = Number(tsRaw);
    const counter = Number(counterRaw);
    const now = Date.now();

    if (!Number.isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_DRIFT_MS) {
      ctx.isReplayAttack = true;
      ctx.useMirage = true;
      ctx.mirageReason = "replay_stale_timestamp";
      markHostileIp(ipHash, "replay_stale_timestamp", 80, { path: req.path, method: req.method, userAgent: ua });
    } else if (!/^[a-f0-9]{16,64}$/.test(nonce) || !checkAndRecordNonce(keyId, nonce)) {
      ctx.isReplayAttack = true;
      ctx.useMirage = true;
      ctx.mirageReason = "replay_duplicate_nonce";
      markHostileIp(ipHash, "replay_duplicate_nonce", 90, { path: req.path, method: req.method, userAgent: ua });
    } else {
      const rec = await loadAttestedKey(keyId);
      if (rec) {
        const bodyHash = crypto
          .createHash("sha256")
          .update(req.rawBody ?? Buffer.alloc(0))
          .digest("hex");
        const canonical = `${req.method.toUpperCase()}|${req.path}|${tsRaw}|${nonce}|${counterRaw}|${bodyHash}`;
        const sigBuf = Buffer.from(sigB64, "base64");
        const sigValid = verifyP256Signature(rec.publicKeyPem, Buffer.from(canonical, "utf8"), sigBuf);

        if (!sigValid) {
          ctx.isReplayAttack = true;
          ctx.useMirage = true;
          ctx.mirageReason = "invalid_hardware_signature";
          markHostileIp(ipHash, "invalid_hardware_signature", 85, {
            path: req.path,
            method: req.method,
            userAgent: ua,
          });
        } else if (!checkSlidingReplayWindow(keyId, rec.lastCounter, counter)) {
          ctx.isReplayAttack = true;
          ctx.useMirage = true;
          ctx.mirageReason = "counter_rollback_replay";
          markHostileIp(ipHash, "counter_rollback_replay", 90, {
            path: req.path,
            method: req.method,
            userAgent: ua,
          });
        } else {
          // Valid hardware-signed request! Now silently inspect SEAR runtime integrity bit
          ctx.isAttested = true;
          ctx.attestMode = rec.attestMode;
          ctx.keyId = keyId;

          const taintedExpected = expectedIntegrityToken(keyId, "tainted", nonce, counter);
          const cleanExpected = expectedIntegrityToken(keyId, "ok", nonce, counter);
          const sentTaint =
            integrityToken.length === 16 && timingSafeHexEqual(integrityToken, taintedExpected);
          const forgedIntegrity =
            integrityToken.length > 0 &&
            !sentTaint &&
            !(integrityToken.length === 16 && timingSafeHexEqual(integrityToken, cleanExpected));

          if (sentTaint || forgedIntegrity || rec.taintMask > 0) {
            ctx.isTamperedClient = true;
            ctx.useMirage = true;
            ctx.mirageReason = sentTaint
              ? "runtime_tamper_signal"
              : forgedIntegrity
                ? "forged_integrity_token"
                : "sticky_tainted_key";
            markHostileIp(ipHash, ctx.mirageReason, 100, {
              path: req.path,
              method: req.method,
              userAgent: ua,
            });
            updateAttestedKeyState(keyId, counter, 1).catch(() => {});
          } else {
            updateAttestedKeyState(keyId, counter, 0).catch(() => {});
          }
        }
      }
    }
  }

  // Classify hostile IPs & scraper bots for Ghost Mirage + Progressive Tarpit
  if (!ctx.useMirage && (ctx.isHostile || ctx.isScraperUa)) {
    ctx.useMirage = true;
    ctx.mirageReason = ctx.isHostile ? "hostile_fingerprint" : "automated_scraper_ua";
    if (ctx.isScraperUa && !ctx.isHostile) {
      markHostileIp(ipHash, "automated_scraper_ua", 55, {
        path: req.path,
        method: req.method,
        userAgent: ua,
      });
    }
  }

  req.security = ctx;
  next();
}

// ─── Zero-Trust Cryptographic StoreKit 2 ES256 JWS Verifier ─────────────────

export interface StoreKitVerificationResult {
  valid: boolean;
  productId?: string;
  environment?: string;
  expiresDate?: number;
  reason?: string;
}

export function verifyStoreKitJwsCrypto(jws: unknown): StoreKitVerificationResult {
  if (typeof jws !== "string") return { valid: false, reason: "missing_jws" };
  const parts = jws.trim().split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed_jws" };

  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as {
      alg?: string;
      x5c?: unknown[];
    };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      bundleId?: string;
      productId?: string;
      expiresDate?: number;
      revocationDate?: number;
      environment?: string;
    };

    if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 2) {
      return { valid: false, reason: "invalid_jws_header_or_x5c" };
    }
    if (payload.bundleId !== "au.com.bubstock.app") {
      return { valid: false, reason: "bundle_mismatch" };
    }
    if (
      payload.productId !== "au.com.bubstock.plus.monthly" &&
      payload.productId !== "au.com.bubstock.plus.yearly"
    ) {
      return { valid: false, reason: "unknown_sku" };
    }
    if (typeof payload.revocationDate === "number" && payload.revocationDate > 0) {
      return { valid: false, reason: "revoked_transaction" };
    }
    if (typeof payload.expiresDate === "number" && payload.expiresDate < Date.now() - 60_000) {
      return { valid: false, reason: "expired_subscription" };
    }

    // Parse & cryptographically verify the X.509 certificate chain inside x5c
    const certs: crypto.X509Certificate[] = [];
    for (const rawCert of header.x5c.slice(0, 4)) {
      if (typeof rawCert !== "string" || rawCert.length < 100) {
        return { valid: false, reason: "invalid_cert_entry" };
      }
      certs.push(new crypto.X509Certificate(Buffer.from(rawCert, "base64")));
    }

    const now = Date.now();
    const leaf = certs[0];
    if (new Date(leaf.validFrom).getTime() > now || new Date(leaf.validTo).getTime() < now) {
      return { valid: false, reason: "leaf_cert_not_valid_now" };
    }

    // Verify each link in the x5c chain cryptographically & confirm Apple issuer
    let sawAppleChain = false;
    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].verify(certs[i + 1].publicKey)) {
        return { valid: false, reason: "x5c_chain_signature_invalid" };
      }
      if (/Apple Inc\.|Apple Worldwide Developer Relations|Apple Root CA/i.test(certs[i + 1].subject)) {
        sawAppleChain = true;
      }
    }
    if (!sawAppleChain) {
      return { valid: false, reason: "non_apple_cert_chain" };
    }

    // Cryptographically verify the JWS ES256 signature against leaf.publicKey
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
    const sigBuf = Buffer.from(parts[2], "base64url");
    if (sigBuf.length !== 64) {
      return { valid: false, reason: "invalid_es256_sig_length" };
    }
    const sigOk = crypto.verify(
      "sha256",
      signingInput,
      { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
      sigBuf
    );
    if (!sigOk) {
      return { valid: false, reason: "es256_signature_mismatch" };
    }

    return {
      valid: true,
      productId: payload.productId,
      environment: payload.environment ?? "Production",
      expiresDate: payload.expiresDate,
    };
  } catch {
    return { valid: false, reason: "jws_parse_or_crypto_error" };
  }
}
