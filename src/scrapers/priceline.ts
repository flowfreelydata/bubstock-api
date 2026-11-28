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
    acceptedStates: string[];
    stateLower: AuStateLower;
    latMin: number;
    latMax: number;
    lonMin: number;
    lonMax: number;
  }
> = {
  melbourne: {
    queries: [
      { lat: -37.8136, lon: 144.9631, radius: "80000" },  // Greater Melbourne + West (Point Cook / Tarneit / Sunshine)
      { lat: -37.5622, lon: 143.8503, radius: "180000" }, // Geelong / Ballarat / Bendigo / Western VIC
      { lat: -36.3833, lon: 145.4000, radius: "220000" }, // Shepparton / Wodonga / Gippsland
      { lat: -34.1855, lon: 142.1625, radius: "150000" }, // Mildura / NW VIC
    ],
    defaultSuburb: "Melbourne",
    stateUpper: "VIC",
    acceptedStates: ["VIC"],
    stateLower: "vic",
    latMin: -39.25,
    latMax: -33.95,
    lonMin: 140.95,
    lonMax: 150.05,
  },
  sydney: {
    queries: [
      { lat: -33.8688, lon: 151.2093, radius: "90000" },  // Greater Sydney + Wollongong + Central Coast
      { lat: -32.9283, lon: 151.7817, radius: "160000" }, // Newcastle / Hunter / Mid-North
      { lat: -35.2809, lon: 149.1300, radius: "200000" }, // Canberra / ACT / Southern NSW / Wagga
      { lat: -30.2963, lon: 153.1135, radius: "260000" }, // Coffs Harbour / Byron / Northern NSW
    ],
    defaultSuburb: "Sydney",
    stateUpper: "NSW",
    acceptedStates: ["NSW", "ACT"],
    stateLower: "nsw",
    latMin: -37.55,
    latMax: -28.15,
    lonMin: 140.95,
    lonMax: 153.68,
  },
  brisbane: {
    queries: [
      { lat: -27.4698, lon: 153.0251, radius: "130000" }, // Brisbane / Gold Coast / Sunshine Coast / Toowoomba
      { lat: -23.3791, lon: 150.5100, radius: "320000" }, // Central QLD (Rockhampton / Mackay / Bundaberg)
      { lat: -19.2590, lon: 146.8169, radius: "360000" }, // North QLD (Townsville / Cairns)
    ],
    defaultSuburb: "Brisbane",
    stateUpper: "QLD",
    acceptedStates: ["QLD"],
    stateLower: "qld",
    latMin: -29.20,
    latMax: -10.50,
    lonMin: 137.95,
    lonMax: 153.60,
  },
  perth: {
    queries: [
      { lat: -31.9505, lon: 115.8605, radius: "100000" }, // Greater Perth + Mandurah
      { lat: -33.3271, lon: 115.6414, radius: "260000" }, // Bunbury / Busselton / Albany
      { lat: -28.7774, lon: 114.6150, radius: "400000" }, // Geraldton / Mid-West / Kalgoorlie
    ],
    defaultSuburb: "Perth",
    stateUpper: "WA",
    acceptedStates: ["WA"],
    stateLower: "wa",
    latMin: -35.20,
    latMax: -13.60,
    lonMin: 112.90,
    lonMax: 129.05,
  },
  adelaide: {
    queries: [
      { lat: -34.9285, lon: 138.6007, radius: "120000" }, // Greater Adelaide / Hills / Barossa / Victor Harbor
      { lat: -33.0333, lon: 137.5667, radius: "260000" }, // Whyalla / Port Augusta / Port Lincoln
      { lat: -37.8284, lon: 140.7804, radius: "140000" }, // Mount Gambier / SE SA
      { lat: -12.4634, lon: 130.8456, radius: "120000" }, // Darwin / Palmerston (NT)
      { lat: -23.6980, lon: 133.8807, radius: "120000" }, // Alice Springs (NT)
    ],
    defaultSuburb: "Adelaide",
    stateUpper: "SA",
    acceptedStates: ["SA", "NT"],
    stateLower: "sa",
    latMin: -38.10,
    latMax: -10.90,
    lonMin: 128.95,
    lonMax: 141.05,
  },
  tasmania: {
    queries: [
      { lat: -42.8821, lon: 147.3272, radius: "100000" }, // Hobart
      { lat: -41.4332, lon: 147.1441, radius: "160000" }, // Launceston + North West
    ],
    defaultSuburb: "Hobart",
    stateUpper: "TAS",
    acceptedStates: ["TAS"],
    stateLower: "tas",
    latMin: -43.75,
    latMax: -39.50,
    lonMin: 143.80,
    lonMax: 148.55,
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

  const accepted = new Set(cfg.acceptedStates);
  await Promise.all(
    cfg.queries.map(async (q) => {
      try {
        const qs = new URLSearchParams({
          latitude: String(q.lat),
          longitude: String(q.lon),
          radius: q.radius,
          pageSize: "200",
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
        if (!r.ok) return;
        const data = (await r.json()) as { stores?: PricelineRawStore[] };

        for (const s of data.stores ?? []) {
          const region = (s.address?.region?.isocodeShort ?? "").toUpperCase();
          if (region && !accepted.has(region)) continue;
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
            state: region === "ACT" ? "act" : cfg.stateLower,
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
    })
  );

  return [...byId.values()].sort((a, b) => a.suburb.localeCompare(b.suburb));
}
