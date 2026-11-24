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

// Official Apple PKI Root CA SHA-256 fingerprints (apple.com/certificateauthority)
const PINNED_APPLE_STOREKIT_ROOT_FINGERPRINTS = new Set<string>([
  // Apple Root CA - G3 (Primary ECDSA-384 root for StoreKit 2 JWS x5c chains)
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
  // Apple Root CA - G2 (Secondary RSA-4096 root)
  "C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50",
]);

// Official Apple App Attestation Root CA PEM (SHA-256: 1C:B9:82:3B:...:42:C9:32)
const APPLE_APP_ATTEST_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const APPLE_APP_ATTEST_ROOT_CA = new crypto.X509Certificate(APPLE_APP_ATTEST_ROOT_CA_PEM);
// ASN.1 DER encoding of Apple App Attest Nonce Extension OID 1.2.840.113635.100.8.2
const APPLE_ATTEST_NONCE_OID_DER = Buffer.from("06092a864886f763640802", "hex");

const MAX_CHALLENGES = 5_000;
const CHALLENGE_TTL_MS = 120_000;
const TIMESTAMP_DRIFT_MS = 120_000;
const MAX_NONCE_CACHE = 25_000;
const REPLAY_WINDOW_SIZE = 64;
const UNATTESTED_VELOCITY_WINDOW_MS = 60_000;
const UNATTESTED_VELOCITY_LIMIT = 14;
const MAX_VELOCITY_TRACKERS = 5_000;

const SCRAPER_BOT_UA_RE =
  /\b(python-requests|python-urllib|scrapy|aiohttp|httpx|go-http-client|wget|libwww-perl|java\/|okhttp|axios\/|node-fetch|puppeteer|playwright|selenium|headlesschrome)\b/i;

export interface RequestSecurityContext {
  ipHash: string;
  isAttested: boolean;
  isAppleHardwareVerified: boolean;
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

// Behavioral velocity tracker for unattested clients scraping distinct products
const unattestedVelocity = new Map<string, { windowStartMs: number; keys: Set<string> }>();

// ─── Minimal Zero-Dependency RFC 8949 CBOR Decoder (for Apple App Attest) ───

function decodeCbor(buf: Buffer): unknown {
  let offset = 0;

  function readUint(addl: number): number {
    if (addl < 24) return addl;
    if (addl === 24) {
      if (offset + 1 > buf.length) throw new Error("cbor_eof");
      return buf[offset++];
    }
    if (addl === 25) {
      if (offset + 2 > buf.length) throw new Error("cbor_eof");
      const v = buf.readUInt16BE(offset);
      offset += 2;
      return v;
    }
    if (addl === 26) {
      if (offset + 4 > buf.length) throw new Error("cbor_eof");
      const v = buf.readUInt32BE(offset);
      offset += 4;
      return v;
    }
    throw new Error("cbor_unsupported_len");
  }

  function parseValue(depth: number): unknown {
    if (depth > 8 || offset >= buf.length) throw new Error("cbor_depth_or_eof");
    const initial = buf[offset++];
    const major = initial >> 5;
    const addl = initial & 0x1f;

    switch (major) {
      case 0:
        return readUint(addl);
      case 1:
        return -1 - readUint(addl);
      case 2: {
        const len = readUint(addl);
        if (offset + len > buf.length) throw new Error("cbor_bytes_eof");
        const slice = buf.subarray(offset, offset + len);
        offset += len;
        return Buffer.from(slice);
      }
      case 3: {
        const len = readUint(addl);
        if (offset + len > buf.length) throw new Error("cbor_text_eof");
        const str = buf.subarray(offset, offset + len).toString("utf8");
        offset += len;
        return str;
      }
      case 4: {
        const len = readUint(addl);
        if (len > 128) throw new Error("cbor_array_too_large");
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) arr.push(parseValue(depth + 1));
        return arr;
      }
      case 5: {
        const len = readUint(addl);
        if (len > 128) throw new Error("cbor_map_too_large");
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) {
          const k = String(parseValue(depth + 1));
          obj[k] = parseValue(depth + 1);
        }
        return obj;
      }
      case 7:
        if (addl === 20) return false;
        if (addl === 21) return true;
        if (addl === 22 || addl === 23) return null;
        throw new Error("cbor_simple_unsupported");
      default:
        throw new Error("cbor_major_unsupported");
    }
  }

  return parseValue(0);
}

/**
 * Cryptographically verifies an Apple `DCAppAttestService` CBOR attestation object:
 * 1. Decodes CBOR map (`fmt === "apple-appattest"`, `attStmt.x5c[]`, `authData`).
 * 2. Verifies `credCert -> intermediateCert -> pinned APPLE_APP_ATTEST_ROOT_CA`.
 * 3. Verifies certificate validity windows.
 * 4. Verifies Apple App Attest Nonce OID `1.2.840.113635.100.8.2` embeds `SHA256(authData || SHA256(challenge))`.
 * 5. When `APPLE_TEAM_ID` is configured, verifies `authData[0..32]` equals `SHA256("<TEAM_ID>.au.com.bubstock.app")`.
 */
export function verifyAppleAppAttestCbor(cborB64: unknown, challenge: string): boolean {
  if (typeof cborB64 !== "string" || cborB64.length < 120 || cborB64.length > 16_000) return false;
  try {
    const raw = Buffer.from(cborB64, "base64");
    const decoded = decodeCbor(raw) as {
      fmt?: unknown;
      attStmt?: { x5c?: unknown[] };
      authData?: unknown;
    };
    if (!decoded || decoded.fmt !== "apple-appattest") return false;
    if (!Buffer.isBuffer(decoded.authData) || decoded.authData.length < 37) return false;
    const x5c = decoded.attStmt?.x5c;
    if (!Array.isArray(x5c) || x5c.length < 2) return false;

    const certs: crypto.X509Certificate[] = [];
    for (const item of x5c.slice(0, 4)) {
      if (!Buffer.isBuffer(item) || item.length < 100) return false;
      certs.push(new crypto.X509Certificate(item));
    }

    const now = Date.now();
    for (const cert of certs) {
      if (new Date(cert.validFrom).getTime() > now || new Date(cert.validTo).getTime() < now) {
        return false;
      }
    }

    // Verify full chain up to our pinned Apple App Attestation Root CA public key
    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].verify(certs[i + 1].publicKey)) return false;
    }
    const top = certs[certs.length - 1];
    const chainsToPinnedAppleRoot =
      top.fingerprint256.toUpperCase() === APPLE_APP_ATTEST_ROOT_CA.fingerprint256.toUpperCase() ||
      top.verify(APPLE_APP_ATTEST_ROOT_CA.publicKey);
    if (!chainsToPinnedAppleRoot) return false;

    // Verify Apple App Attest Nonce extension: SHA256(authData || SHA256(challenge))
    const clientDataHash = crypto.createHash("sha256").update(challenge, "utf8").digest();
    const expectedNonce = crypto
      .createHash("sha256")
      .update(Buffer.concat([decoded.authData, clientDataHash]))
      .digest();

    const credRaw = certs[0].raw;
    const oidPos = credRaw.indexOf(APPLE_ATTEST_NONCE_OID_DER);
    if (oidPos === -1) return false;
    // The 32-byte nonce octet string follows directly inside the extension envelope after the OID
    const extWindow = credRaw.subarray(oidPos, Math.min(credRaw.length, oidPos + 96));
    if (extWindow.indexOf(expectedNonce) === -1) return false;

    // Optional strict App ID hash check once APPLE_TEAM_ID is configured in Railway
    const teamId = process.env.APPLE_TEAM_ID?.trim();
    if (teamId) {
      const expectedRpHash = crypto
        .createHash("sha256")
        .update(`${teamId}.au.com.bubstock.app`, "utf8")
        .digest();
      const actualRpHash = decoded.authData.subarray(0, 32);
      if (!crypto.timingSafeEqual(expectedRpHash, actualRpHash)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

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

  const hasValidAppleAttest = verifyAppleAppAttestCbor(params.appAttestObjectB64, challenge);
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

function checkUnattestedScraperVelocity(ipHash: string, req: Request): boolean {
  if (
    req.path !== "/prices" &&
    req.path !== "/compare" &&
    req.path !== "/specials" &&
    req.path !== "/compare/gaps"
  ) {
    return false;
  }
  const now = Date.now();
  const targetKey = `${req.path}:${String(req.query.product ?? req.query.category ?? "all").toLowerCase().slice(0, 48)}`;
  let tracker = unattestedVelocity.get(ipHash);
  if (!tracker || now - tracker.windowStartMs > UNATTESTED_VELOCITY_WINDOW_MS) {
    if (unattestedVelocity.size >= MAX_VELOCITY_TRACKERS && !unattestedVelocity.has(ipHash)) {
      const oldest = unattestedVelocity.keys().next().value;
      if (oldest) unattestedVelocity.delete(oldest);
    }
    tracker = { windowStartMs: now, keys: new Set<string>() };
    unattestedVelocity.set(ipHash, tracker);
  }
  tracker.keys.add(targetKey);
  return tracker.keys.size > UNATTESTED_VELOCITY_LIMIT;
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
  res: Response,
  next: NextFunction
): Promise<void> {
  const ipHash = hashIp(req.ip);
  const ua = String(req.headers["user-agent"] ?? "");
  const isScraperUa = SCRAPER_BOT_UA_RE.test(ua);
  const isWidgetClient = String(req.headers["x-bubstock-client"] ?? "").toLowerCase() === "ios-widget";

  const ctx: RequestSecurityContext = {
    ipHash,
    isAttested: false,
    isAppleHardwareVerified: false,
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
      if (!rec) {
        // Key unknown on server (e.g. fresh DB or env switch) — hint legitimate iOS client to re-enroll cleanly
        res.setHeader("X-Bubstock-Reenroll", "1");
      } else {
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
          // Valid signed request! Now silently inspect SEAR runtime integrity bit
          ctx.isAttested = true;
          ctx.attestMode = rec.attestMode;
          ctx.isAppleHardwareVerified = rec.attestMode === "app_attest";
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
  } else if (!isWidgetClient && checkUnattestedScraperVelocity(ipHash, req)) {
    // High-velocity unattested harvester spoofing a browser/iPhone UA -> trap in Ghost Mirage!
    ctx.useMirage = true;
    ctx.mirageReason = "unattested_velocity_scrape";
    markHostileIp(ipHash, "unattested_velocity_scrape", 75, {
      path: req.path,
      method: req.method,
      userAgent: ua,
    });
  }

  // Strict CGNAT override: ONLY truly Apple-PKI-verified `app_attest` hardware keys may override
  // an IP-level hostile ban — self-enrolled software/unattested keys CANNOT escape a hostile IP ban!
  const verifiedAppleHardware =
    ctx.isAppleHardwareVerified && !ctx.isTamperedClient && !ctx.isReplayAttack && !ctx.isScraperUa;

  if (!ctx.useMirage && !verifiedAppleHardware && (ctx.isHostile || ctx.isScraperUa)) {
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

// ─── Zero-Trust Cryptographic StoreKit 2 ES256 JWS Verifier (Pinned Apple Root CA) ─

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

    // Parse & verify EVERY certificate's date window inside x5c
    const certs: crypto.X509Certificate[] = [];
    const now = Date.now();
    for (const rawCert of header.x5c.slice(0, 4)) {
      if (typeof rawCert !== "string" || rawCert.length < 100) {
        return { valid: false, reason: "invalid_cert_entry" };
      }
      const cert = new crypto.X509Certificate(Buffer.from(rawCert, "base64"));
      if (new Date(cert.validFrom).getTime() > now || new Date(cert.validTo).getTime() < now) {
        return { valid: false, reason: "cert_not_valid_now" };
      }
      certs.push(cert);
    }

    // Verify EVERY cryptographic link in the x5c chain
    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].verify(certs[i + 1].publicKey)) {
        return { valid: false, reason: "x5c_chain_signature_invalid" };
      }
    }

    // CRITICAL: Pin the root certificate directly to official Apple Root CA - G3 / G2 SHA-256 fingerprints
    // (Rejects any self-signed forged certificate even if CN="Apple Root CA"!)
    const rootCert = certs[certs.length - 1];
    const rootFp = rootCert.fingerprint256.toUpperCase();
    if (!PINNED_APPLE_STOREKIT_ROOT_FINGERPRINTS.has(rootFp) || !rootCert.verify(rootCert.publicKey)) {
      return { valid: false, reason: "untrusted_root_ca_fingerprint" };
    }

    // Cryptographically verify the JWS ES256 signature against leaf.publicKey
    const leaf = certs[0];
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
