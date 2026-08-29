import axios from "axios";
import type { PriceEntry } from "../types.js";

const BASE = "https://www.woolworths.com.au";
const SEARCH_URL = `${BASE}/apis/ui/Search/products`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ─── Session cache ────────────────────────────────────────────────────────────
// Priming fetches the homepage to collect Akamai + session cookies.
// Cached for 5 minutes so parallel requests share one session.

let sessionCookie = "";
let sessionExpiry = 0;

async function getSession(): Promise<string> {
  if (Date.now() < sessionExpiry && sessionCookie) return sessionCookie;
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
    sessionCookie = raw.map((c) => c.split(";")[0]).join("; ");
    sessionExpiry = Date.now() + 5 * 60 * 1000;
    console.log(`[woolworths] session primed (${raw.length} cookie(s))`);
  } catch (err) {
    console.warn("[woolworths] session prime failed:", (err as Error).message);
    sessionCookie = "";
  }
  return sessionCookie;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface WoolworthsProduct {
  Stockcode?: number;
  Name?: string;
  Price?: number;
  WasPrice?: number;
  IsOnSpecial?: boolean;
  CupMeasure?: string;
  CupPrice?: number;
  PromotionEnd?: string;
  PackageSize?: string;
}

interface WoolworthsResponse {
  Products?: Array<{ Products?: WoolworthsProduct[] }>;
  SearchResultsCount?: number;
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export async function searchWoolworthsPrices(
  productName: string,
  suburb: string,
  state: string
): Promise<PriceEntry[]> {
  const cookie = await getSession();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.get<WoolworthsResponse>(SEARCH_URL, {
        params: {
          searchTerm: productName,
          pageSize: 24,
          pageNumber: 1,
          sortType: "TraderRelevance",
          isMobile: "false",
          isSpecial: "false",
          filters: "",
        },
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-AU,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          Referer: `${BASE}/shop/search/products?searchTerm=${encodeURIComponent(productName)}`,
          Origin: BASE,
          "X-Requested-With": "XMLHttpRequest",
          "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeout: 14_000,
      });

      const entries: PriceEntry[] = [];
      const seen = new Set<number>();

      for (const bundle of (r.data.Products ?? []).slice(0, 10)) {
        for (const p of bundle.Products ?? []) {
          if (!p.Price || !p.Stockcode) continue;
          if (seen.has(p.Stockcode)) continue;
          if (p.Price < 0.5 || p.Price > 300) continue;
          seen.add(p.Stockcode);
          entries.push({
            retailer: "Woolworths",
            storeName: `Woolworths ${suburb}`,
            suburb,
            state,
            price: p.Price,
            currency: "AUD",
            unit: p.CupMeasure ?? p.PackageSize ?? "",
            isOnSale: p.IsOnSpecial ?? false,
            saleEndsAt: p.PromotionEnd ?? undefined,
            lastUpdated: new Date().toISOString(),
          });
        }
      }

      console.log(`[woolworths] ${entries.length} result(s) for "${productName}"`);
      return entries;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt === 0) {
        console.warn(`[woolworths] attempt 1 failed (${msg}), retrying…`);
        // Invalidate session so retry gets fresh cookies
        sessionExpiry = 0;
        await new Promise((res) => setTimeout(res, 1_500 + Math.random() * 1_000));
        continue;
      }
      console.warn("[woolworths] scrape failed:", msg);
      return [];
    }
  }
  return [];
}
