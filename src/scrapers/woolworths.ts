import axios from "axios";
import type { PriceEntry } from "../types.js";

const SEARCH_URL =
  "https://www.woolworths.com.au/apis/ui/Search/products";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en;q=0.9",
  Referer: "https://www.woolworths.com.au/",
  Origin: "https://www.woolworths.com.au",
};

interface WoolworthsProduct {
  Stockcode?: number;
  Name?: string;
  Price?: number;
  WasPrice?: number;
  IsOnSpecial?: boolean;
  CupMeasure?: string;
  CupPrice?: number;
  PromotionEnd?: string;
}

interface WoolworthsResponse {
  Products?: Array<{ Products?: WoolworthsProduct[] }>;
  SearchResultsCount?: number;
}

export async function searchWoolworthsPrices(
  productName: string,
  suburb: string,
  state: string
): Promise<PriceEntry[]> {
  try {
    const response = await axios.get<WoolworthsResponse>(SEARCH_URL, {
      params: {
        searchTerm: productName,
        pageSize: 12,
        pageNumber: 1,
        sortType: "TraderRelevance",
        isMobile: "true",
        filters: "",
      },
      headers: HEADERS,
      timeout: 9000,
    });

    const bundles = response.data?.Products ?? [];
    const entries: PriceEntry[] = [];

    for (const bundle of bundles.slice(0, 6)) {
      const products = bundle.Products ?? [];
      for (const p of products) {
        if (!p.Price) continue;
        entries.push({
          retailer: "Woolworths",
          storeName: `Woolworths ${suburb}`,
          suburb,
          state,
          price: p.Price,
          currency: "AUD",
          unit: p.CupMeasure ?? "",
          isOnSale: p.IsOnSpecial ?? false,
          saleEndsAt: p.PromotionEnd ?? undefined,
          lastUpdated: new Date().toISOString(),
        });
      }
    }

    return entries;
  } catch (err) {
    // Scraping failed — the app uses seeded fallback data
    console.warn("[woolworths] scrape failed:", (err as Error).message);
    return [];
  }
}
