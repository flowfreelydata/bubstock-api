import type {
  AuCity,
  AuStateLower,
  AuStateUpper,
  MelbourneStore,
  PriceEntry,
  RetailerFeedStatus,
} from "../types.js";

const API_BASE = "https://api.priceline.com.au/occ/v2/priceline";
const WEB_BASE = "https://www.priceline.com.au";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CITY_CENTERS: Record<
  AuCity,
  {
    queries: Array<{ lat: number; lon: number; radius: string }>;
    defaultSuburb: string;
    stateUpper: AuStateUpper;
    stateLower: AuStateLower;
    latMin: number;
    latMax: number;
    lonMin: number;
    lonMax: number;
  }
> = {
  melbourne: {
    queries: [{ lat: -37.8136, lon: 144.9631, radius: "55000" }],
    defaultSuburb: "Melbourne",
    stateUpper: "VIC",
    stateLower: "vic",
    latMin: -38.30,
    latMax: -37.50,
    lonMin: 144.45,
    lonMax: 145.55,
  },
  sydney: {
    queries: [{ lat: -33.8688, lon: 151.2093, radius: "55000" }],
    defaultSuburb: "Sydney",
    stateUpper: "NSW",
    stateLower: "nsw",
    latMin: -34.18,
    latMax: -33.55,
    lonMin: 150.60,
    lonMax: 151.35,
  },
  brisbane: {
    queries: [{ lat: -27.4698, lon: 153.0251, radius: "55000" }],
    defaultSuburb: "Brisbane",
    stateUpper: "QLD",
    stateLower: "qld",
    latMin: -28.05,
    latMax: -27.05,
    lonMin: 152.65,
    lonMax: 153.55,
  },
  perth: {
    queries: [{ lat: -31.9505, lon: 115.8605, radius: "65000" }],
    defaultSuburb: "Perth",
    stateUpper: "WA",
    stateLower: "wa",
    latMin: -32.60,
    latMax: -31.45,
    lonMin: 115.60,
    lonMax: 116.25,
  },
  adelaide: {
    queries: [{ lat: -34.9285, lon: 138.6007, radius: "55000" }],
    defaultSuburb: "Adelaide",
    stateUpper: "SA",
    stateLower: "sa",
    latMin: -35.30,
    latMax: -34.55,
    lonMin: 138.45,
    lonMax: 138.85,
  },
  tasmania: {
    queries: [
      { lat: -42.8821, lon: 147.3272, radius: "80000" }, // Hobart
      { lat: -41.4332, lon: 147.1441, radius: "120000" }, // Launceston + North West
    ],
    defaultSuburb: "Hobart",
    stateUpper: "TAS",
    stateLower: "tas",
    latMin: -43.65,
    latMax: -40.65,
    lonMin: 144.50,
    lonMax: 148.50,
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
  state: AuStateUpper = "VIC"
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
  city: AuCity
): Promise<MelbourneStore[]> {
  const cfg = CITY_CENTERS[city];
  const byId = new Map<string, MelbourneStore>();

  for (const q of cfg.queries) {
    try {
      const qs = new URLSearchParams({
        latitude: String(q.lat),
        longitude: String(q.lon),
        radius: q.radius,
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
      if (!r.ok) continue;
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
        const rawSuburb = (s.address?.town ?? cfg.defaultSuburb).trim();
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
  }

  return [...byId.values()].sort((a, b) => a.suburb.localeCompare(b.suburb));
}
