import crypto from "node:crypto";
import http2 from "node:http2";

/**
 * Zero-dependency Apple Push Notification service (APNs) HTTP/2 client.
 *
 * Uses Apple's token-based (.p8) authentication (ES256 JWT) over persistent HTTP/2.
 * Configure these 3 optional Railway environment variables when ready to send
 * server-side remote pushes to iOS devices:
 *   - APNS_KEY_ID      (10-char Key ID from Apple Developer Portal)
 *   - APNS_TEAM_ID     (10-char Team ID from Apple Developer Portal)
 *   - APNS_PRIVATE_KEY (contents of AuthKey_XXXXXXXXXX.p8; \n escaped or multiline)
 *   - APNS_BUNDLE_ID   (defaults to "au.com.bubstock.app")
 *   - APNS_SANDBOX     ("true" for Xcode debug builds, omit/false for App Store/TestFlight)
 *
 * When APNs env vars are not set yet, iOS devices still receive instant price-drop
 * alerts via BGAppRefreshTask polling GET /alerts/check every few hours.
 */

let cachedJwt = "";
let cachedJwtExpiry = 0;

export function isApnsConfigured(): boolean {
  return Boolean(
    process.env.APNS_KEY_ID &&
      process.env.APNS_TEAM_ID &&
      process.env.APNS_PRIVATE_KEY
  );
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getApnsJwt(): string | null {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const rawKey = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!keyId || !teamId || !rawKey) return null;

  const now = Math.floor(Date.now() / 1000);
  // Apple allows reusing a token for up to 60 min; refresh at 45 min
  if (cachedJwt && now < cachedJwtExpiry) {
    return cachedJwt;
  }

  const header = base64Url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = base64Url(JSON.stringify({ iss: teamId, iat: now }));
  const unsigned = `${header}.${payload}`;

  const signature = crypto.sign("sha256", Buffer.from(unsigned), {
    key: rawKey,
    dsaEncoding: "ieee-p1363",
  });

  cachedJwt = `${unsigned}.${base64Url(signature)}`;
  cachedJwtExpiry = now + 45 * 60;
  return cachedJwt;
}

export interface ApnsAlertPayload {
  title: string;
  body: string;
  threadId?: string;
  data?: Record<string, string>;
}

export async function sendApnsPush(
  deviceToken: string,
  alert: ApnsAlertPayload
): Promise<{ ok: boolean; status: number; reason?: string }> {
  const jwt = getApnsJwt();
  if (!jwt) {
    return { ok: false, status: 0, reason: "APNs not configured" };
  }

  const cleanToken = deviceToken.replace(/[^a-fA-F0-9]/g, "");
  if (cleanToken.length < 32) {
    return { ok: false, status: 400, reason: "Invalid APNs token" };
  }

  const host =
    process.env.APNS_SANDBOX === "true"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  const topic = process.env.APNS_BUNDLE_ID?.trim() || "au.com.bubstock.app";

  const body = JSON.stringify({
    aps: {
      alert: {
        title: alert.title,
        body: alert.body,
      },
      sound: "default",
      "thread-id": alert.threadId ?? "bubstock-deals",
    },
    ...(alert.data ?? {}),
  });

  return new Promise((resolve) => {
    const client = http2.connect(host);
    let settled = false;
    const finish = (res: { ok: boolean; status: number; reason?: string }) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(res);
    };

    client.on("error", (err) => finish({ ok: false, status: 0, reason: err.message }));

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${cleanToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });

    let status = 0;
    let rawResp = "";
    req.setTimeout(8_000, () => {
      req.close();
      finish({ ok: false, status: 408, reason: "APNs timeout" });
    });
    req.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", (chunk) => {
      rawResp += String(chunk);
    });
    req.on("end", () => {
      if (status === 200) {
        finish({ ok: true, status });
      } else {
        let reason = rawResp.slice(0, 120);
        try {
          reason = (JSON.parse(rawResp) as { reason?: string }).reason ?? reason;
        } catch {
          // keep raw
        }
        finish({ ok: false, status, reason });
      }
    });
    req.on("error", (err) => finish({ ok: false, status: 0, reason: err.message }));
    req.end(body);
  });
}
