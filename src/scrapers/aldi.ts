import type { MelbourneStore, PriceEntry, RetailerFeedStatus } from "../types.js";

const API_BASE = "https://api.aldi.com.au";
const WEB_BASE = "https://www.aldi.com.au";
// Verified active ALDI AU catalogue service point
const MELBOURNE_SERVICE_POINT = "G452";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const MELB_LAT_MIN = -38.30;
const MELB_LAT_MAX = -37.50;
const MELB_LON_MIN = 144.45;
const MELB_LON_MAX = 145.55;

interface AldiProduct {
  sku?: string;
  name?: string;
  brandName?: string;
  urlSlugText?: string;
  sellingSize?: string;
  price?: {
    amount?: number;
    amountRelevant?: number;
    amountRelevantDisplay?: string;
    wasPriceDisplay?: string;
    comparisonDisplay?: string;
  };
  assets?: Array<{ url?: string; assetType?: string }>;
}

interface AldiSearchResponse {
  data?: AldiProduct[];
}

export interface AldiScraperResult {
  entries: PriceEntry[];
  status: RetailerFeedStatus;
}

export async function searchAldiPrices(
  productName: string,
  suburb: string,
  state = "VIC"
): Promise<AldiScraperResult> {
  const t0 = Date.now();
  try {
    const qs = new URLSearchParams({
      currency: "AUD",
      serviceType: "walk-in",
      q: productName,
      limit: "12",
      offset: "0",
      sort: "relevance",
      servicePoint: MELBOURNE_SERVICE_POINT,
    });
    const r = await fetch(`${API_BASE}/v3/product-search?${qs.toString()}`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: WEB_BASE,
        Referer: `${WEB_BASE}/`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }

    const data = (await r.json()) as AldiSearchResponse;
    const nowIso = new Date().toISOString();
    const entries: PriceEntry[] = [];

    for (const item of (data?.data ?? []).slice(0, 6)) {
      const cents = item.price?.amountRelevant ?? item.price?.amount;
      if (!cents || cents < 50 || cents > 35000) continue;
      const price = Number((cents / 100).toFixed(2));

      const wasMatch = item.price?.wasPriceDisplay?.match(/(\d+(?:\.\d{1,2})?)/);
      const wasNum = wasMatch ? Number(wasMatch[1]) : undefined;
      const wasPrice = wasNum && wasNum > price ? Number(wasNum.toFixed(2)) : undefined;
      const savingsPercent = wasPrice
        ? Math.round(((wasPrice - price) / wasPrice) * 100)
        : undefined;

      const rawImg = item.assets?.[0]?.url;
      const imageUrl = rawImg
        ? rawImg.replace("{width}", "300").replace("{slug}", item.urlSlugText ?? "product")
        : undefined;

      const productUrl =
        item.urlSlugText && item.sku
          ? `${WEB_BASE}/product/${item.urlSlugText}-${item.sku}`
          : undefined;

      entries.push({
        retailer: "ALDI",
        storeName: "ALDI Victoria",
        suburb,
        state: state.toUpperCase(),
        matchedName: [item.brandName, item.name].filter(Boolean).join(" ").trim() || productName,
        brand: item.brandName?.trim() || undefined,
        stockcode: item.sku,
        price,
        wasPrice,
        savingsPercent,
        currency: "AUD",
        unit: item.price?.comparisonDisplay ?? item.sellingSize ?? "",
        isOnSale: Boolean(wasPrice),
        isInStock: undefined,
        imageUrl,
        productUrl,
        lastUpdated: nowIso,
      });
    }

    return {
      entries,
      status: {
        retailer: "ALDI",
        status: entries.length > 0 ? "live" : "no_match",
        count: entries.length,
        latencyMs: Date.now() - t0,
        note:
          entries.length > 0
            ? "Live ALDI AU catalogue prices (in-store stock varies)"
            : "No matching ALDI line",
      },
    };
  } catch (err) {
    return {
      entries: [],
      status: {
        retailer: "ALDI",
        status: "unavailable",
        count: 0,
        latencyMs: Date.now() - t0,
        note: `Feed unavailable (${(err as Error).message.slice(0, 60)})`,
      },
    };
  }
}

// ─── Real Greater Melbourne ALDI Stores ──────────────────────────────────────

interface AldiRawServicePoint {
  id?: string;
  name?: string;
  publicPhoneNumber?: string | null;
  address?: {
    regionIsoCode?: string;
    address1?: string;
    city?: string;
    zipCode?: string;
    latitude?: string | number;
    longitude?: string | number;
  };
}

const MELBOURNE_ALDI_POINTS: Array<[number, number]> = [
  [-37.8136, 144.9631],
  [-37.7100, 144.9800],
  [-37.8200, 145.1800],
  [-37.9400, 145.1200],
  [-38.1200, 145.1400],
  [-37.8400, 144.7500],
];

const STANDARD_ALDI_VIC_HOURS = [
  { weekday: 1, openMinute: 9 * 60, closeMinute: 20 * 60 },
  { weekday: 2, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 3, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 4, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 5, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 6, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 7, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
];

export async function fetchAldiMelbourneStores(): Promise<MelbourneStore[]> {
  const byId = new Map<string, MelbourneStore>();

  for (const [lat, lon] of MELBOURNE_ALDI_POINTS) {
    try {
      const qs = new URLSearchParams({
        addressLatitude: String(lat),
        addressLongitude: String(lon),
        radius: "35000",
        "page[limit]": "50",
      });
      const r = await fetch(`${API_BASE}/v2/service-points?${qs.toString()}`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Origin: WEB_BASE,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) continue;
      const data = (await r.json()) as { data?: AldiRawServicePoint[] };

      for (const s of data?.data ?? []) {
        if (!s.id || s.id === "000-000") continue;
        const addr = s.address;
        if (!addr || (addr.regionIsoCode ?? "").toUpperCase() !== "VIC") continue;
        const slat = Number(addr.latitude);
        const slon = Number(addr.longitude);
        if (
          !Number.isFinite(slat) ||
          !Number.isFinite(slon) ||
          slat < MELB_LAT_MIN ||
          slat > MELB_LAT_MAX ||
          slon < MELB_LON_MIN ||
          slon > MELB_LON_MAX
        ) {
          continue;
        }
        const id = `aldi-${s.id}`;
        if (byId.has(id)) continue;

        const suburb = (addr.city ?? "Melbourne").trim();
        byId.set(id, {
          id,
          retailer: "aldi",
          storeNo: s.id,
          name: suburb,
          streetAddress: (addr.address1 ?? s.name ?? "").trim(),
          suburb,
          state: "vic",
          postcode: (addr.zipCode ?? "3000").trim(),
          latitude: slat,
          longitude: slon,
          phone: s.publicPhoneNumber?.trim() || undefined,
          hours: STANDARD_ALDI_VIC_HOURS,
          hasDedicatedBabyAisle: false,
          source: "aldi_api",
        });
      }
    } catch (err) {
      console.warn(`[aldi] store lookup (${lat},${lon}) failed:`, (err as Error).message);
    }
  }

  return [...byId.values()].sort((a, b) => a.suburb.localeCompare(b.suburb));
}
