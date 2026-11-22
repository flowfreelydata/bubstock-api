import type { MelbourneStore, PriceEntry, RetailerFeedStatus } from "../types.js";

const API_BASE = "https://api.priceline.com.au/occ/v2/priceline";
const WEB_BASE = "https://www.priceline.com.au";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CITY_CENTERS = {
  melbourne: {
    lat: -37.8136,
    lon: 144.9631,
    stateUpper: "VIC",
    stateLower: "vic" as const,
    latMin: -38.30,
    latMax: -37.50,
    lonMin: 144.45,
    lonMax: 145.55,
  },
  sydney: {
    lat: -33.8688,
    lon: 151.2093,
    stateUpper: "NSW",
    stateLower: "nsw" as const,
    latMin: -34.18,
    latMax: -33.55,
    lonMin: 150.60,
    lonMax: 151.35,
  },
};

interface PricelineProduct {
  code?: string;
  name?: string;
  brandName?: string;
  url?: string;
  image_url?: string;
  price?: { value?: number; formattedValue?: string };
  wasPrice?: { value?: number };
  stock?: { stockLevelStatus?: string };
  unitPrice?: string;
}

export interface PricelineScraperResult {
  entries: PriceEntry[];
  status: RetailerFeedStatus;
}

export async function searchPricelinePrices(
  productName: string,
  suburb: string,
  state: "VIC" | "NSW" = "VIC"
): Promise<PricelineScraperResult> {
  const t0 = Date.now();
  try {
    const qs = new URLSearchParams({
      query: productName,
      pageSize: "10",
      fields: "FULL",
    });
    const r = await fetch(`${API_BASE}/products/search?${qs.toString()}`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: WEB_BASE,
        Referer: `${WEB_BASE}/`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { products?: PricelineProduct[] };

    const nowIso = new Date().toISOString();
    const entries: PriceEntry[] = [];

    for (const p of (data.products ?? []).slice(0, 8)) {
      const price = p.price?.value;
      if (!price || !Number.isFinite(price) || price < 0.5 || price > 350) continue;

      const was =
        p.wasPrice?.value && p.wasPrice.value > price
          ? Number(p.wasPrice.value.toFixed(2))
          : undefined;
      const savingsPercent = was
        ? Math.round(((was - price) / was) * 100)
        : undefined;

      const stockStatus = (p.stock?.stockLevelStatus ?? "").toLowerCase();
      const isInStock =
        stockStatus === "instock"
          ? true
          : stockStatus === "outofstock"
            ? false
            : undefined;

      const productUrl = p.url
        ? p.url.startsWith("http")
          ? p.url
          : `${WEB_BASE}${p.url}`
        : undefined;

      entries.push({
        retailer: "Priceline",
        storeName: `Priceline Pharmacy (${state})`,
        suburb,
        state,
        matchedName: (p.name ?? productName).trim(),
        brand: p.brandName?.trim() || undefined,
        stockcode: p.code,
        price: Number(price.toFixed(2)),
        wasPrice: was,
        savingsPercent,
        currency: "AUD",
        unit: p.unitPrice ?? "",
        isOnSale: Boolean(was),
        isInStock,
        imageUrl: p.image_url || undefined,
        productUrl,
        lastUpdated: nowIso,
      });
    }

    return {
      entries,
      status: {
        retailer: "Priceline",
        status: entries.length > 0 ? "live" : "no_match",
        count: entries.length,
        latencyMs: Date.now() - t0,
        note:
          entries.length > 0
            ? "Live Priceline Pharmacy catalogue & stock"
            : "No matching Priceline line",
      },
    };
  } catch (err) {
    return {
      entries: [],
      status: {
        retailer: "Priceline",
        status: "unavailable",
        count: 0,
        latencyMs: Date.now() - t0,
        note: `Feed unavailable (${(err as Error).message.slice(0, 60)})`,
      },
    };
  }
}

// ─── Real Greater Melbourne & Greater Sydney Priceline Pharmacies ────────────

interface PricelineRawStore {
  name?: string;
  displayName?: string;
  geoPoint?: { latitude?: number; longitude?: number };
  address?: {
    line1?: string;
    line2?: string;
    town?: string;
    postalCode?: string;
    phone?: string;
    region?: { isocodeShort?: string };
  };
}

export async function fetchPricelineCityStores(
  city: "melbourne" | "sydney"
): Promise<MelbourneStore[]> {
  const cfg = CITY_CENTERS[city];
  const byId = new Map<string, MelbourneStore>();

  try {
    const qs = new URLSearchParams({
      latitude: String(cfg.lat),
      longitude: String(cfg.lon),
      radius: "50000",
      pageSize: "150",
      fields: "FULL",
    });
    const r = await fetch(`${API_BASE}/stores?${qs.toString()}`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: WEB_BASE,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { stores?: PricelineRawStore[] };

    for (const s of data.stores ?? []) {
      const region = (s.address?.region?.isocodeShort ?? "").toUpperCase();
      if (region && region !== cfg.stateUpper) continue;
      const lat = Number(s.geoPoint?.latitude);
      const lon = Number(s.geoPoint?.longitude);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < cfg.latMin ||
        lat > cfg.latMax ||
        lon < cfg.lonMin ||
        lon > cfg.lonMax
      ) {
        continue;
      }

      const id = `priceline-${(s.name ?? `${Math.round(lat * 10000)}-${Math.round(lon * 10000)}`).replace(/[^a-zA-Z0-9-]/g, "")}`;
      if (byId.has(id)) continue;

      const streetAddress = [s.address?.line1, s.address?.line2].filter(Boolean).join(", ").trim();
      const rawSuburb = (s.address?.town ?? (city === "sydney" ? "Sydney" : "Melbourne")).trim();
      const suburb = rawSuburb
        .toLowerCase()
        .replace(/\b\w/g, (ch) => ch.toUpperCase());

      byId.set(id, {
        id,
        retailer: "priceline",
        storeNo: s.name,
        name: (s.displayName ?? `Priceline Pharmacy ${suburb}`).trim(),
        streetAddress,
        suburb,
        state: cfg.stateLower,
        postcode: (s.address?.postalCode ?? "").trim(),
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lon.toFixed(6)),
        phone: s.address?.phone?.trim() || undefined,
        hours: [],
        hasDedicatedBabyAisle: false,
        source: "priceline_api",
      });
    }
  } catch (err) {
    console.warn(`[priceline] ${city} stores fetch failed:`, (err as Error).message);
  }

  return [...byId.values()].sort((a, b) => a.suburb.localeCompare(b.suburb));
}
