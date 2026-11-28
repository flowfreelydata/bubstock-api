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
// ASN.1 DER value hex for Apple App Attest Nonce Extension OID 1.2.840.113635.100.8.2
const APPLE_ATTEST_NONCE_OID_HEX = "2a864886f763640802";
// ASN.1 DER value hex for Apple StoreKit 2 / App Store Receipt Signing Leaf OID 1.2.840.113635.100.6.11.1
const APPLE_STOREKIT_LEAF_OID_HEX = "2a864886f76364060b01";
// Official Apple App Attest 16-byte AAGUIDs (developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
const APP_ATTEST_PROD_AAGUID = Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7, 0)]);
const APP_ATTEST_DEV_AAGUID = Buffer.from("appattestdevelop", "ascii");

const MAX_CHALLENGES = 5_000;
const CHALLENGE_TTL_MS = 120_000;
const TIMESTAMP_DRIFT_MS = 120_000;
const MAX_NONCE_CACHE = 25_000;
const MAX_COUNTER_WINDOWS = 10_000;
const REPLAY_WINDOW_SIZE = 64;
const UNATTESTED_VELOCITY_WINDOW_MS = 60_000;
const UNATTESTED_VELOCITY_LIMIT = 14;
const SOFT_ATTESTED_VELOCITY_LIMIT = 24;
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

// Per-IP daily new key enrollment cap (blocks unlimited self-enrolled software key farming)
const MAX_ENROLLS_PER_IP_DAY = 12;
const MAX_ENROLL_IP_TRACKERS = 5_000;
const ipEnrollTracker = new Map<string, { windowStartMs: number; keys: Set<string> }>();

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
        const obj = Object.create(null) as Record<string, unknown>;
        for (let i = 0; i < len; i++) {
          const k = String(parseValue(depth + 1));
          if (k === "__proto__" || k === "constructor" || k === "prototype") {
            throw new Error("cbor_forbidden_key");
          }
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

// ─── Minimal Zero-Dependency ASN.1 DER X.509 Extension Parser ───────────────

interface DerNode {
  tag: number;
  valueStart: number;
  valueEnd: number;
  end: number;
}

function readDerNode(buf: Buffer, offset: number, limit = buf.length): DerNode | null {
  if (offset < 0 || offset + 2 > limit) return null;
  const tag = buf[offset];
  const lenByte = buf[offset + 1];
  let len = 0;
  let headerLen = 2;
  if ((lenByte & 0x80) === 0) {
    len = lenByte;
  } else {
    const numOctets = lenByte & 0x7f;
    if (numOctets === 0 || numOctets > 3 || offset + 2 + numOctets > limit) return null;
    for (let i = 0; i < numOctets; i++) {
      len = len * 256 + buf[offset + 2 + i];
    }
    headerLen = 2 + numOctets;
  }
  const valueStart = offset + headerLen;
  const valueEnd = valueStart + len;
  if (valueEnd > limit || len < 0) return null;
  return { tag, valueStart, valueEnd, end: valueEnd };
}

function parseX509Extensions(certRaw: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const certSeq = readDerNode(certRaw, 0);
  if (!certSeq || certSeq.tag !== 0x30) return out;
  const tbsSeq = readDerNode(certRaw, certSeq.valueStart, certSeq.valueEnd);
  if (!tbsSeq || tbsSeq.tag !== 0x30) return out;

  let cursor = tbsSeq.valueStart;
  let extWrapper: DerNode | null = null;
  while (cursor < tbsSeq.valueEnd) {
    const child = readDerNode(certRaw, cursor, tbsSeq.valueEnd);
    if (!child) return out;
    if (child.tag === 0xa3) {
      extWrapper = child;
      break;
    }
    cursor = child.end;
  }
  if (!extWrapper) return out;

  const extSeq = readDerNode(certRaw, extWrapper.valueStart, extWrapper.valueEnd);
  if (!extSeq || extSeq.tag !== 0x30) return out;

  let extCursor = extSeq.valueStart;
  while (extCursor < extSeq.valueEnd) {
    const ext = readDerNode(certRaw, extCursor, extSeq.valueEnd);
    if (!ext || ext.tag !== 0x30) break;
    const oidNode = readDerNode(certRaw, ext.valueStart, ext.valueEnd);
    if (oidNode && oidNode.tag === 0x06) {
      let valNode = readDerNode(certRaw, oidNode.end, ext.valueEnd);
      if (valNode && valNode.tag === 0x01) {
        valNode = readDerNode(certRaw, valNode.end, ext.valueEnd);
      }
      if (valNode && valNode.tag === 0x04) {
        const oidHex = certRaw.subarray(oidNode.valueStart, oidNode.valueEnd).toString("hex");
        out.set(oidHex, certRaw.subarray(valNode.valueStart, valNode.valueEnd));
      }
    }
    extCursor = ext.end;
  }
  return out;
}

function extractAppAttestNonce(certRaw: Buffer): Buffer | null {
  const exts = parseX509Extensions(certRaw);
  const extVal = exts.get(APPLE_ATTEST_NONCE_OID_HEX);
  if (!extVal) return null;
  const outerSeq = readDerNode(extVal, 0);
  if (!outerSeq || outerSeq.tag !== 0x30) return null;
  let cursor = outerSeq.valueStart;
  while (cursor < outerSeq.valueEnd) {
    const field = readDerNode(extVal, cursor, outerSeq.valueEnd);
    if (!field) return null;
    if (field.tag === 0xa1) {
      const oct = readDerNode(extVal, field.valueStart, field.valueEnd);
      if (oct && oct.tag === 0x04) {
        return extVal.subarray(oct.valueStart, oct.valueEnd);
      }
    }
    cursor = field.end;
  }
  return null;
}

/**
 * Cryptographically verifies an Apple `DCAppAttestService` CBOR attestation object:
 * 1. Decodes CBOR map (`fmt === "apple-appattest"`, `attStmt.x5c[]`, `authData`).
 * 2. Verifies `credCert -> intermediateCert -> pinned APPLE_APP_ATTEST_ROOT_CA` + CA basic constraints.
 * 3. Verifies certificate validity windows.
 * 4. Strictly parses ASN.1 X.509 Extension OID `1.2.840.113635.100.8.2` to verify `SHA256(authData || SHA256(challenge:keyId))`.
 * 5. When `APPLE_TEAM_ID` is configured, verifies `authData[0..32]` equals `SHA256("<TEAM_ID>.au.com.bubstock.app")`.
 */
export function verifyAppleAppAttestCbor(cborB64: unknown, challenge: string, keyId: string): boolean {
  if (typeof cborB64 !== "string" || cborB64.length < 120 || cborB64.length > 16_000) return false;
  try {
    const raw = Buffer.from(cborB64, "base64");
    const decoded = decodeCbor(raw) as {
      fmt?: unknown;
      attStmt?: { x5c?: unknown[] };
      authData?: unknown;
    };
    if (!decoded || decoded.fmt !== "apple-appattest") return false;
    // authData must contain rpIdHash(32) + flags(1) + signCount(4) + aaguid(16) + credIdLen(2) + credId(>=32)
    if (!Buffer.isBuffer(decoded.authData) || decoded.authData.length < 87) return false;
    const x5c = decoded.attStmt?.x5c;
    if (!Array.isArray(x5c) || x5c.length < 2 || x5c.length > 5) return false;

    const certs: crypto.X509Certificate[] = [];
    for (const item of x5c) {
      if (!Buffer.isBuffer(item) || item.length < 100) return false;
      certs.push(new crypto.X509Certificate(item));
    }

    // Leaf credential certificate must NOT be a CA; all intermediate/root certificates MUST be CAs
    if (certs[0].ca) return false;
    for (let i = 1; i < certs.length; i++) {
      if (!certs[i].ca) return false;
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

    // Strictly parse ASN.1 DER Extension 1.2.840.113635.100.8.2 and verify bound nonce via constant-time compare
    const boundClientDataHash = crypto.createHash("sha256").update(`${challenge}:${keyId}`, "utf8").digest();
    const expectedBoundNonce = crypto
      .createHash("sha256")
      .update(Buffer.concat([decoded.authData, boundClientDataHash]))
      .digest();

    const extractedNonce = extractAppAttestNonce(certs[0].raw);
    if (
      !extractedNonce ||
      extractedNonce.length !== expectedBoundNonce.length ||
      !crypto.timingSafeEqual(extractedNonce, expectedBoundNonce)
    ) {
      return false;
    }

    // Apple App Attest Step 5: initial attestation signCount MUST be 0
    const signCount = decoded.authData.readUInt32BE(33);
    if (signCount !== 0) return false;

    // Apple App Attest Step 6: verify AAGUID is genuine Apple App Attest (reject dev builds in production)
    const aaguid = decoded.authData.subarray(37, 53);
    const isProdAaguid = crypto.timingSafeEqual(aaguid, APP_ATTEST_PROD_AAGUID);
    const isDevAaguid = crypto.timingSafeEqual(aaguid, APP_ATTEST_DEV_AAGUID);
    const allowDevAttest = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_APP_ATTEST === "1";
    if (!isProdAaguid && !(isDevAaguid && allowDevAttest)) return false;

    // Apple App Attest Step 7: verify credentialId equals SHA256 of leaf cert's uncompressed EC P-256 public key
    const credIdLen = decoded.authData.readUInt16BE(53);
    if (credIdLen !== 32 || decoded.authData.length < 55 + credIdLen) return false;
    const credId = decoded.authData.subarray(55, 55 + credIdLen);
    const leafSpki = certs[0].publicKey.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(leafSpki) || leafSpki.length < 65) return false;
    const leafRawPoint = leafSpki.subarray(leafSpki.length - 65);
    if (leafRawPoint[0] !== 0x04) return false;
    const expectedCredId = crypto.createHash("sha256").update(leafRawPoint).digest();
    if (!crypto.timingSafeEqual(credId, expectedCredId)) return false;

    // Apple App Attest Step 4 (Fail-Closed in Production):
    // Require APPLE_TEAM_ID so no foreign Apple Developer account's app can claim app_attest trust.
    const teamId = process.env.APPLE_TEAM_ID?.trim();
    const isProd = process.env.NODE_ENV === "production";
    if (!teamId) {
      if (isProd && process.env.ALLOW_UNPINNED_TEAM_ID !== "1") {
        return false;
      }
    } else {
      if (!/^[A-Z0-9]{10}$/.test(teamId)) return false;
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

export function consumeAttestChallenge(challenge: string, ipHash: string): boolean {
  const rec = challengeCache.get(challenge);
  if (!rec) return false;
  challengeCache.delete(challenge);
  return rec.expiresAtMs > Date.now() && rec.ipHash === ipHash;
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

  if (!consumeAttestChallenge(challenge, params.ipHash)) {
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

  const existing = await loadAttestedKey(keyId);
  if (existing && existing.publicKeyPem !== publicKeyPem) {
    return { ok: false, status: 403, error: "Key identifier mismatch" };
  }

  // Rate-cap distinct new hardware key enrollments per IP per 24h (anti-Sybil key farming)
  if (!existing) {
    const nowMs = Date.now();
    let ipRec = ipEnrollTracker.get(params.ipHash);
    if (!ipRec || nowMs - ipRec.windowStartMs > 24 * 3600 * 1000) {
      if (ipEnrollTracker.size >= MAX_ENROLL_IP_TRACKERS && !ipEnrollTracker.has(params.ipHash)) {
        const oldest = ipEnrollTracker.keys().next().value;
        if (oldest) ipEnrollTracker.delete(oldest);
      }
      ipRec = { windowStartMs: nowMs, keys: new Set<string>() };
      ipEnrollTracker.set(params.ipHash, ipRec);
    }
    if (!ipRec.keys.has(keyId) && ipRec.keys.size >= MAX_ENROLLS_PER_IP_DAY) {
      markHostileIp(params.ipHash, "excessive_key_enrollments", 70, { path: "/attest/enroll", method: "POST" });
      return { ok: false, status: 429, error: "Daily device enrollment limit reached for this network" };
    }
    ipRec.keys.add(keyId);
  }

  const hasValidAppleAttest = verifyAppleAppAttestCbor(params.appAttestObjectB64, challenge, keyId);
  const rawMode = typeof params.attestMode === "string" ? params.attestMode : "secure_enclave";
  const candidateMode: AttestedKeyRecord["attestMode"] = hasValidAppleAttest
    ? "app_attest"
    : rawMode === "dev_keychain"
      ? "dev_keychain"
      : "secure_enclave";
  const attestMode: AttestedKeyRecord["attestMode"] =
    existing?.attestMode === "app_attest" ? "app_attest" : candidateMode;

  // Silent SEAR trap: if a re-signed IPA clone enrolls with a different bundleId, DO NOT reject!
  // Accept enrollment silently with taintMask = 1 so every subsequent request hits the Ghost Mirage!
  const bundleTampered = bundleId !== "au.com.bubstock.app";
  const taintMask = (existing?.taintMask ?? 0) | (bundleTampered ? 1 : 0);
  const preservedCounter = existing ? existing.lastCounter : 0;
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
    appAttestCbor: hasValidAppleAttest ? String(params.appAttestObjectB64) : existing?.appAttestCbor,
    bundleId,
    lastCounter: preservedCounter,
    taintMask,
    enrolledIpHash: params.ipHash,
  });

  if (!counterWindows.has(keyId)) {
    if (counterWindows.size >= MAX_COUNTER_WINDOWS) {
      const oldest = counterWindows.keys().next().value;
      if (oldest) counterWindows.delete(oldest);
    }
    counterWindows.set(keyId, { highest: preservedCounter, seen: new Set<number>() });
  }
  return { ok: true, status: 201, mode: attestMode };
}

function checkSlidingReplayWindow(keyId: string, dbLastCounter: number, counter: number): boolean {
  if (!Number.isSafeInteger(counter) || counter <= 0) return false;
  let win = counterWindows.get(keyId);
  if (!win) {
    if (counterWindows.size >= MAX_COUNTER_WINDOWS) {
      const oldest = counterWindows.keys().next().value;
      if (oldest) counterWindows.delete(oldest);
    }
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

const VELOCITY_TRACKED_PATHS = new Set<string>([
  "/prices",
  "/compare",
  "/specials",
  "/compare/gaps",
  "/prices/history",
  "/pulse",
  "/melbourne/pulse",
  "/recalls",
  "/stores",
]);

function normalizeRoutePath(rawPath: string): string {
  const p = rawPath.toLowerCase().replace(/\/+$/, "");
  return p || "/";
}

function firstQueryString(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return "";
}

function checkUnattestedScraperVelocity(ipHash: string, req: Request, limit = UNATTESTED_VELOCITY_LIMIT): boolean {
  const normPath = normalizeRoutePath(req.path);
  if (!VELOCITY_TRACKED_PATHS.has(normPath)) {
    return false;
  }
  const now = Date.now();
  const minLat = firstQueryString(req.query.minLat);
  const minLon = firstQueryString(req.query.minLon);
  const bboxKey =
    minLat && minLon
      ? `bbox:${Math.round(Number(minLat) * 4) || 0},${Math.round(Number(minLon) * 4) || 0}`
      : "";
  const targetVal =
    firstQueryString(req.query.product) ||
    firstQueryString(req.query.category) ||
    bboxKey ||
    firstQueryString(req.query.state) ||
    "all";
  const targetKey = `${normPath}:${targetVal.toLowerCase().slice(0, 48)}`;
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
  return tracker.keys.size > limit;
}

function verifyIntegritySignature(
  publicKeyPem: string,
  integrityHeader: string,
  nonce: string,
  counter: number
): "ok" | "tainted" | "forged" {
  if (!integrityHeader) return "forged";
  const sigBuf = Buffer.from(integrityHeader, "base64");
  if (sigBuf.length !== 64 && (sigBuf.length < 68 || sigBuf.length > 74)) {
    return "forged";
  }
  if (verifyP256Signature(publicKeyPem, Buffer.from(`ok:${nonce}:${counter}`, "utf8"), sigBuf)) {
    return "ok";
  }
  if (verifyP256Signature(publicKeyPem, Buffer.from(`tainted:${nonce}:${counter}`, "utf8"), sigBuf)) {
    return "tainted";
  }
  return "forged";
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
  const normPath = normalizeRoutePath(req.path);
  const ctx: RequestSecurityContext = {
    ipHash,
    isAttested: false,
    isAppleHardwareVerified: false,
    attestMode: "none",
    isScraperUa,
    isHostile: isHostileIp(ipHash),
    isTamperedClient: false,
    isReplayAttack: false,
    useMirage: false,
  };

  const keyId = String(req.headers["x-bubstock-key-id"] ?? "").trim().toLowerCase();
  const tsRaw = String(req.headers["x-bubstock-ts"] ?? "").trim();
  const nonce = String(req.headers["x-bubstock-nonce"] ?? "").trim().toLowerCase();
  const counterRaw = String(req.headers["x-bubstock-counter"] ?? "").trim();
  const sigB64 = String(req.headers["x-bubstock-sig"] ?? "").trim();
  const integritySig = String(req.headers["x-bubstock-integrity"] ?? "").trim();

  if (keyId && tsRaw && nonce && counterRaw && sigB64) {
    const ts = Number(tsRaw);
    const counter = Number(counterRaw);
    const now = Date.now();

    if (!Number.isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_DRIFT_MS) {
      // Clock skew on a phone must never ban a shared IP or poison prices — simply mark unattested.
      ctx.isReplayAttack = true;
    } else if (!/^[a-f0-9]{16,64}$/.test(nonce)) {
      ctx.isReplayAttack = true;
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
        const sigVersion = String(req.headers["x-bubstock-sig-v"] ?? "").trim();
        const rawUrl = req.originalUrl || req.url || req.path;
        const isPrivateSignedGet =
          req.method.toUpperCase() === "GET" &&
          (normPath === "/alerts/check" ||
            normPath === "/referrals/status" ||
            normPath.startsWith("/groups/") ||
            normPath.startsWith("/household/sync/") ||
            normPath.startsWith("/relay/"));
        const sigBuf = Buffer.from(sigB64, "base64");
        let sigValid = false;
        let v3IntegrityVerdict: "ok" | "tainted" | null = null;
        if (sigVersion === "3") {
          // Single-signature v3 folds integrity tag directly into the canonical request signature (50% less Secure Enclave IPC!)
          const baseV3 = `${req.method.toUpperCase()}|${rawUrl}|${tsRaw}|${nonce}|${counterRaw}|${bodyHash}`;
          if (verifyP256Signature(rec.publicKeyPem, Buffer.from(`${baseV3}|ok`, "utf8"), sigBuf)) {
            sigValid = true;
            v3IntegrityVerdict = "ok";
          } else if (verifyP256Signature(rec.publicKeyPem, Buffer.from(`${baseV3}|tainted`, "utf8"), sigBuf)) {
            sigValid = true;
            v3IntegrityVerdict = "tainted";
          }
        } else if (sigVersion === "2") {
          const canonicalV2 = `${req.method.toUpperCase()}|${rawUrl}|${tsRaw}|${nonce}|${counterRaw}|${bodyHash}`;
          sigValid = verifyP256Signature(rec.publicKeyPem, Buffer.from(canonicalV2, "utf8"), sigBuf);
        } else if (!(isPrivateSignedGet && rawUrl.includes("?"))) {
          const canonicalV1 = `${req.method.toUpperCase()}|${req.path}|${tsRaw}|${nonce}|${counterRaw}|${bodyHash}`;
          sigValid = verifyP256Signature(rec.publicKeyPem, Buffer.from(canonicalV1, "utf8"), sigBuf);
        }

        if (!sigValid) {
          ctx.isReplayAttack = true;
          res.setHeader("X-Bubstock-Reenroll", "1");
        } else if (!checkAndRecordNonce(keyId, nonce)) {
          ctx.isReplayAttack = true;
        } else if (!checkSlidingReplayWindow(keyId, rec.lastCounter, counter)) {
          ctx.isReplayAttack = true;
        } else {
          // Valid signed request! Verify ECDSA-signed runtime integrity claim (unforgeable without private key)
          ctx.isAttested = true;
          ctx.attestMode = rec.attestMode;
          ctx.isAppleHardwareVerified = rec.attestMode === "app_attest";
          ctx.keyId = keyId;

          const integrityVerdict =
            v3IntegrityVerdict ?? verifyIntegritySignature(rec.publicKeyPem, integritySig, nonce, counter);
          const sentTaint = integrityVerdict === "tainted";
          const forgedIntegrity = integrityVerdict === "forged";

          if (sentTaint || forgedIntegrity || rec.taintMask > 0) {
            ctx.isTamperedClient = true;
            ctx.isAttested = false;
            updateAttestedKeyState(keyId, counter, 1).catch(() => {});
          } else {
            updateAttestedKeyState(keyId, counter, 0).catch(() => {});
          }
        }
      }
    }
  }

  // IMPORTANT (ACCC & Customer Accuracy Guarantee):
  // NEVER serve fabricated/drifted "Ghost Mirage" prices to ANY caller on HTTP 200 OK.
  // Abuse and scraper UAs are handled cleanly via honest HTTP 403 / 429 rate limits,
  // never by returning misleading grocery/formula prices or banning shared AU CGNAT IPs.
  ctx.useMirage = false;

  req.security = ctx;
  next();
}

// ─── Zero-Trust Cryptographic StoreKit 2 ES256 JWS Verifier (Pinned Apple Root CA) ─

export interface StoreKitVerificationResult {
  valid: boolean;
  productId?: string;
  originalTransactionId?: string;
  environment?: string;
  expiresDate?: number;
  reason?: string;
}

export function verifyStoreKitJwsCrypto(jws: unknown): StoreKitVerificationResult {
  if (typeof jws !== "string" || jws.length < 100 || jws.length > 24_000) {
    return { valid: false, reason: "invalid_jws_size" };
  }
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
      originalTransactionId?: string | number;
      transactionId?: string | number;
      expiresDate?: number;
      revocationDate?: number;
      environment?: string;
    };

    if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 2 || header.x5c.length > 5) {
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
    if (typeof payload.expiresDate !== "number" || payload.expiresDate < Date.now() - 60_000) {
      return { valid: false, reason: "expired_or_missing_expiry" };
    }
    // Fail-closed in production: reject Sandbox/Xcode test receipts unless explicitly allowed
    const allowSandbox =
      process.env.NODE_ENV !== "production" || process.env.ALLOW_SANDBOX_RECEIPTS === "1";
    if (payload.environment !== "Production" && !allowSandbox) {
      return { valid: false, reason: "sandbox_receipt_rejected_in_production" };
    }

    // Parse & verify EVERY certificate's date window inside x5c
    const certs: crypto.X509Certificate[] = [];
    const now = Date.now();
    for (const rawCert of header.x5c) {
      if (typeof rawCert !== "string" || rawCert.length < 100) {
        return { valid: false, reason: "invalid_cert_entry" };
      }
      const cert = new crypto.X509Certificate(Buffer.from(rawCert, "base64"));
      if (new Date(cert.validFrom).getTime() > now || new Date(cert.validTo).getTime() < now) {
        return { valid: false, reason: "cert_not_valid_now" };
      }
      certs.push(cert);
    }

    if (certs[0].ca) {
      return { valid: false, reason: "leaf_cert_cannot_be_ca" };
    }
    for (let i = 1; i < certs.length; i++) {
      if (!certs[i].ca) {
        return { valid: false, reason: "intermediate_or_root_must_be_ca" };
      }
    }

    // Leaf cert must carry Apple's official StoreKit / App Store Receipt Signing extension OID (1.2.840.113635.100.6.11.1)
    const leafExtensions = parseX509Extensions(certs[0].raw);
    if (!leafExtensions.has(APPLE_STOREKIT_LEAF_OID_HEX)) {
      return { valid: false, reason: "missing_apple_storekit_leaf_oid" };
    }

    // Verify EVERY cryptographic link in the x5c chain
    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].verify(certs[i + 1].publicKey)) {
        return { valid: false, reason: "x5c_chain_signature_invalid" };
      }
    }

    // CRITICAL: Pin the root certificate directly to official Apple Root CA - G3 / G2 SHA-256 fingerprints
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

    const rawOrigId = payload.originalTransactionId ?? payload.transactionId;
    const originalTransactionId =
      rawOrigId !== undefined && rawOrigId !== null ? String(rawOrigId).trim().slice(0, 80) : undefined;

    return {
      valid: true,
      productId: payload.productId,
      originalTransactionId: originalTransactionId || undefined,
      environment: payload.environment ?? "Production",
      expiresDate: payload.expiresDate,
    };
  } catch {
    return { valid: false, reason: "jws_parse_or_crypto_error" };
  }
}
