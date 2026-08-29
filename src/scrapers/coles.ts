import axios from "axios";
import type { PriceEntry } from "../types.js";

const BASE = "https://www.coles.com.au";
const REST_URL = `${BASE}/api/2.0/page/products/search`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ─── Session + buildId cache ──────────────────────────────────────────────────
// Coles is a Next.js site. We grab the homepage to:
//   1. Collect session / Akamai cookies
//   2. Extract the Next.js buildId for the _next/data fallback route

interface ColesSession {
  cookie: string;
  buildId: string | null;
  expiry: number;
}

let _session: ColesSession = { cookie: "", buildId: null, expiry: 0 };

async function getSession(): Promise<ColesSession> {
  if (Date.now() < _session.expiry && _session.cookie) return _session;
  try {
    const r = await axios.get<string>(BASE, {
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      maxRedirects: 5,
      timeout: 12_000,
    });

    const raw = (r.headers["set-cookie"] as string[] | undefined) ?? [];
    const cookie = raw.map((c) => c.split(";")[0]).join("; ");
    const match = String(r.data).match(/"buildId":"([^"]+)"/);
    const buildId = match?.[1] ?? null;

    _session = { cookie, buildId, expiry: Date.now() + 5 * 60 * 1000 };
    console.log(
      `[coles] session primed (${raw.length} cookie(s), buildId: ${buildId ?? "not found"})`
    );
  } catch (err) {
    console.warn("[coles] session prime failed:", (err as Error).message);
    _session = { cookie: "", buildId: null, expiry: Date.now() + 60_000 };
  }
  return _session;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ColesProduct {
  name?: string;
  brand?: string;
  size?: string;
  pricing?: {
    now?: number;
    was?: number;
    comparable?: string;
    promotionCalloutText?: string;
  };
}

interface ColesRestResponse {
  results?: ColesProduct[];
  noOfResults?: number;
}

interface ColesNextResponse {
  pageProps?: {
    searchResults?: {
      results?: ColesProduct[];
      noOfResults?: number;
    };
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildHeaders(cookie: string, referer: string) {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-AU,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: referer,
    Origin: BASE,
    "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function toEntry(item: ColesProduct, suburb: string, state: string): PriceEntry | null {
  const price = item.pricing?.now;
  if (!price || price < 0.5 || price > 300) return null;
  const was = item.pricing?.was;
  return {
    retailer: "Coles",
    storeName: `Coles ${suburb}`,
    suburb,
    state,
    price,
    currency: "AUD",
    unit: item.pricing?.comparable ?? item.size ?? "",
    isOnSale: !!was && was > price,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export async function searchColesPrices(
  productName: string,
  suburb: string,
  state: string
): Promise<PriceEntry[]> {
  const { cookie, buildId } = await getSession();
  const referer = `${BASE}/search?q=${encodeURIComponent(productName)}`;
  const headers = buildHeaders(cookie, referer);

  // ── Attempt 1: REST API ────────────────────────────────────────────────────
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.get<ColesRestResponse>(REST_URL, {
        params: { q: productName, page: 1 },
        headers,
        timeout: 14_000,
      });

      const results = r.data?.results ?? [];
      if (results.length > 0) {
        const entries = results
          .slice(0, 10)
          .map((item) => toEntry(item, suburb, state))
          .filter((e): e is PriceEntry => e !== null);
        console.log(`[coles] ${entries.length} result(s) via REST for "${productName}"`);
        return entries;
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt === 0) {
        console.warn(`[coles] REST attempt 1 failed (${msg}), retrying…`);
        _session.expiry = 0; // force session refresh on retry
        const { cookie: c2 } = await getSession();
        headers["Cookie"] = c2;
        await new Promise((res) => setTimeout(res, 1_500 + Math.random() * 1_000));
        continue;
      }
      console.warn("[coles] REST failed:", msg);
    }
    break;
  }

  // ── Attempt 2: Next.js data route (fallback) ───────────────────────────────
  if (buildId) {
    try {
      const nextUrl = `${BASE}/_next/data/${buildId}/en-AU/search.json`;
      const r = await axios.get<ColesNextResponse>(nextUrl, {
        params: { q: productName, page: 1 },
        headers: {
          ...headers,
          Accept: "application/json",
          "Sec-Fetch-Dest": "empty",
        },
        timeout: 14_000,
      });

      const results = r.data?.pageProps?.searchResults?.results ?? [];
      const entries = results
        .slice(0, 10)
        .map((item) => toEntry(item, suburb, state))
        .filter((e): e is PriceEntry => e !== null);
      console.log(`[coles] ${entries.length} result(s) via Next.js for "${productName}"`);
      return entries;
    } catch (err) {
      console.warn("[coles] Next.js fallback failed:", (err as Error).message);
    }
  }

  console.warn(`[coles] all attempts exhausted for "${productName}"`);
  return [];
}
