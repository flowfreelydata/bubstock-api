import axios from "axios";
import type { PriceEntry } from "../types.js";

// Coles GraphQL / REST search endpoint (internal, best-effort)
const SEARCH_URL = "https://www.coles.com.au/api/2.0/page/products/search";
const GRAPHQL_URL = "https://www.coles.com.au/_next/data";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  Accept: "application/json",
  "Accept-Language": "en-AU,en;q=0.9",
  Referer: "https://www.coles.com.au/",
  Origin: "https://www.coles.com.au",
};

interface ColesProduct {
  name?: string;
  brand?: string;
  size?: string;
  pricing?: {
    now?: number;
    was?: number;
    unit?: { price?: number; quantity?: { size?: number; unitType?: string } };
    comparable?: string;
    promotionCalloutText?: string;
    onlineSaleOnly?: boolean;
  };
}

interface ColesSearchResponse {
  results?: ColesProduct[];
  noOfResults?: number;
}

export async function searchColesPrices(
  productName: string,
  suburb: string,
  state: string
): Promise<PriceEntry[]> {
  try {
    const response = await axios.get<ColesSearchResponse>(SEARCH_URL, {
      params: { q: productName, page: 1 },
      headers: HEADERS,
      timeout: 9000,
    });

    const results = response.data?.results ?? [];
    const entries: PriceEntry[] = [];

    for (const item of results.slice(0, 6)) {
      const price = item.pricing?.now;
      if (!price) continue;
      entries.push({
        retailer: "Coles",
        storeName: `Coles ${suburb}`,
        suburb,
        state,
        price,
        currency: "AUD",
        unit: item.pricing?.comparable ?? item.size ?? "",
        isOnSale: !!item.pricing?.was && item.pricing.was > price,
        lastUpdated: new Date().toISOString(),
      });
    }

    return entries;
  } catch (err) {
    console.warn("[coles] scrape failed:", (err as Error).message);
    return [];
  }
}
