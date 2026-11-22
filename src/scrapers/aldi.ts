import type {
  AldiEquivalent,
  AuCity,
  AuStateLower,
  AuStateUpper,
  MelbourneStore,
  PriceEntry,
  RetailerFeedStatus,
} from "../types.js";

const API_BASE = "https://api.aldi.com.au";
const WEB_BASE = "https://www.aldi.com.au";
// Verified active ALDI AU catalogue service point (national mainland pricing)
const DEFAULT_SERVICE_POINT = "G452";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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

function toPriceEntry(
  item: AldiProduct,
  fallbackName: string,
  suburb: string,
  state: string,
  nowIso: string
): PriceEntry | null {
  const cents = item.price?.amountRelevant ?? item.price?.amount;
  if (!cents || cents < 50 || cents > 35000) return null;
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

  return {
    retailer: "ALDI",
    storeName: `ALDI (${state.toUpperCase()})`,
    suburb,
    state: state.toUpperCase(),
    matchedName: [item.brandName, item.name].filter(Boolean).join(" ").trim() || fallbackName,
    brand: item.brandName?.trim() || "MAMIA",
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
  };
}

export async function searchAldiPrices(
  productName: string,
  suburb: string,
  state: AuStateUpper = "VIC"
): Promise<AldiScraperResult> {
  const t0 = Date.now();
  if (state === "TAS") {
    return {
      entries: [],
      status: {
        retailer: "ALDI",
        status: "unavailable",
        count: 0,
        latencyMs: 0,
        note: "ALDI does not operate stores in Tasmania",
      },
    };
  }

  try {
    const qs = new URLSearchParams({
      currency: "AUD",
      serviceType: "walk-in",
      q: productName,
      limit: "12",
      offset: "0",
      sort: "relevance",
      servicePoint: DEFAULT_SERVICE_POINT,
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
      const entry = toPriceEntry(item, productName, suburb, state, nowIso);
      if (entry) entries.push(entry);
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
            : "ALDI carries exclusive Mamia baby lines",
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

// ─── Live Cached ALDI Mamia Baby Catalogue + Smart Equivalent Matcher ────────

let mamiaCache: AldiProduct[] = [];
let mamiaCacheExpiry = 0;

async function loadAldiMamiaCatalogue(): Promise<AldiProduct[]> {
  if (mamiaCache.length > 0 && Date.now() < mamiaCacheExpiry) {
    return mamiaCache;
  }
  try {
    const qs = new URLSearchParams({
      currency: "AUD",
      serviceType: "walk-in",
      q: "mamia",
      limit: "60",
      offset: "0",
      sort: "relevance",
      servicePoint: DEFAULT_SERVICE_POINT,
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
    if (!r.ok) return mamiaCache;
    const data = (await r.json()) as AldiSearchResponse;
    const items = (data?.data ?? []).filter((p) => (p.brandName ?? "").toUpperCase() === "MAMIA");
    if (items.length > 0) {
      mamiaCache = items;
      mamiaCacheExpiry = Date.now() + 2 * 60 * 60 * 1000; // 2h cache: 1 upstream call serves all AU!
    }
    return mamiaCache;
  } catch {
    return mamiaCache;
  }
}

/**
 * Matches a branded baby item (Aptamil, Huggies, Rafferty's Garden, WaterWipes, etc.)
 * to its exact same-stage / same-size live ALDI Mamia equivalent so parents can compare
 * everyday ALDI budget value honestly against Woolworths, Coles, IGA & Priceline.
 *
 * Safety guard: never suggests standard cow's-milk Mamia formula for goat, soy,
 * lactose-free, AR/reflux, or prescription/hypoallergenic specialty formulas.
 */
export async function findAldiMamiaEquivalent(
  productName: string,
  suburb: string,
  state: AuStateUpper
): Promise<AldiEquivalent | undefined> {
  if (state === "TAS") return undefined;

  const q = productName.toLowerCase();
  // Don't double-show as "equivalent" if user literally searched Mamia directly
  if (q.includes("mamia")) return undefined;

  const catalogue = await loadAldiMamiaCatalogue();
  if (catalogue.length === 0) return undefined;

  const nowIso = new Date().toISOString();
  const findItem = (re: RegExp) => catalogue.find((p) => re.test(`${p.brandName ?? ""} ${p.name ?? ""}`));

  // 1. Infant & Toddler Formula (strict safety guard for specialist/non-cow formulas)
  if (/\b(formula|toddler milk|junior milk|follow[- ]?on|starter)\b/i.test(q)) {
    if (/\b(goat|soy|lactose|allergy|pepti|alfamino|neocate|elecare|novalac|reflux|ar\b|comfort|colic|sensitive|ha\b|organic)\b/i.test(q)) {
      return undefined;
    }
    let item: AldiProduct | undefined;
    let label = "Infant Formula (900g)";
    if (/\b(stage\s*4|step\s*4|junior|2\s*\+?\s*year)\b/i.test(q)) {
      item = findItem(/junior\s+stage\s*4/i);
      label = "Stage 4 Junior Milk (900g)";
    } else if (/\b(stage\s*3|step\s*3|toddler|12\+?\s*m)/i.test(q)) {
      item = findItem(/toddler\s+stage\s*3/i);
      label = "Stage 3 Toddler Milk (900g)";
    } else if (/\b(stage\s*2|step\s*2|follow[- ]?on|6[- ]?12)/i.test(q)) {
      item = findItem(/follow\s+on\s+stage\s*2/i);
      label = "Stage 2 Follow-On Formula (900g)";
    } else {
      item = findItem(/newborn\s+stage\s*1/i);
      label = "Stage 1 Newborn Formula (900g)";
    }
    if (item) {
      const entry = toPriceEntry(item, productName, suburb, state, nowIso);
      if (entry) {
        return {
          categoryLabel: label,
          entry,
          note: "ALDI exclusive Mamia standard cow's-milk formula — compare by 100g price",
        };
      }
    }
    return undefined;
  }

  // 2. Nappy Pants & Nappies (exact size match 1–6)
  if (/\b(napp(y|ies)|pull[- ]?up|drynites|night pants)\b/i.test(q)) {
    const isPants = /\b(pants|walker|pull[- ]?up)\b/i.test(q);
    const sizeMatch = q.match(/\bsize\s*([1-6])\b/i) ?? q.match(/\b(newborn|infant|crawler|toddler|walker|junior)\b/i);
    let sizeNum: number | null = null;
    if (sizeMatch) {
      const token = sizeMatch[1].toLowerCase();
      if (/^[1-6]$/.test(token)) sizeNum = Number(token);
      else if (token === "newborn") sizeNum = 1;
      else if (token === "infant") sizeNum = 2;
      else if (token === "crawler") sizeNum = 3;
      else if (token === "toddler") sizeNum = 4;
      else if (token === "walker") sizeNum = 5;
      else if (token === "junior") sizeNum = 6;
    }

    let item: AldiProduct | undefined;
    let label = "ALDI Mamia Nappies";

    if (/\b(night|bed\s*mat|drynites)\b/i.test(q)) {
      item = findItem(/night pants/i);
      label = "Night Pants (10pk)";
    } else if (isPants && sizeNum && sizeNum >= 4 && sizeNum <= 6) {
      item = findItem(new RegExp(`size\\s*${sizeNum}\\s+nappy\\s+pants`, "i"));
      label = `Size ${sizeNum} Nappy Pants`;
    } else if (sizeNum && sizeNum >= 1 && sizeNum <= 6) {
      item = findItem(new RegExp(`size\\s*${sizeNum}\\s+nappies`, "i"));
      label = `Size ${sizeNum} Nappies`;
    } else {
      item = findItem(/size\s*4\s+nappies/i);
      label = "Size 4 Nappies (50pk)";
    }

    if (item) {
      const entry = toPriceEntry(item, productName, suburb, state, nowIso);
      if (entry) {
        return {
          categoryLabel: label,
          entry,
          note: "ALDI exclusive Mamia brand — compare cost per nappy",
        };
      }
    }
    return undefined;
  }

  // 3. Baby Wipes
  if (/\bwipes?\b/i.test(q)) {
    const isWater = /\bwater\b/i.test(q);
    const isBulk = /\b(bulk|box|384|400|480|576|6\s*pack|8\s*pack)\b/i.test(q);
    const item = isWater
      ? findItem(/baby water wipes/i)
      : isBulk
        ? findItem(/480 pack/i)
        : findItem(/fragrance free 80 pack/i);
    if (item) {
      const entry = toPriceEntry(item, productName, suburb, state, nowIso);
      if (entry) {
        return {
          categoryLabel: isWater ? "Water Wipes (80pk)" : isBulk ? "Bulk Baby Wipes (480pk)" : "Fragrance-Free Wipes (80pk)",
          entry,
          note: "ALDI exclusive Mamia brand — compare cost per 100 wipes",
        };
      }
    }
    return undefined;
  }

  // 4. Baby Food Pouches & Purees
  if (/\b(pouch|puree|custard|rafferty|only organic|bellamy.*pouch|heinz.*baby|baby food)\b/i.test(q)) {
    const isOrganic = /\borganic\b/i.test(q);
    const item = isOrganic
      ? findItem(/organic baby food/i)
      : /\bcustard\b/i.test(q)
        ? findItem(/vanilla custard|banana custard/i)
        : findItem(/apple,?\s*banana.*120g/i) ?? findItem(/baby food 120g/i);
    if (item) {
      const entry = toPriceEntry(item, productName, suburb, state, nowIso);
      if (entry) {
        return {
          categoryLabel: isOrganic ? "Organic Baby Pouch (120g)" : "Baby Food Pouch (120g)",
          entry,
          note: "ALDI exclusive Mamia 120g pouch — everyday budget benchmark",
        };
      }
    }
    return undefined;
  }

  // 5. Baby Snacks (Rusks, Puffs, Fruit Bars)
  if (/\b(rusk|teething|puff|round-?a-?bout|bellies|oat bar|cereal bar)\b/i.test(q)) {
    const item = /\brusk|teething\b/i.test(q)
      ? findItem(/rice rusk/i)
      : /\bbar\b/i.test(q)
        ? findItem(/fruit & oat bars/i)
        : findItem(/rice puffs/i);
    if (item) {
      const entry = toPriceEntry(item, productName, suburb, state, nowIso);
      if (entry) {
        return {
          categoryLabel: "ALDI Mamia Baby Snack",
          entry,
          note: "ALDI exclusive Mamia snack — compare by 100g price",
        };
      }
    }
  }

  return undefined;
}

// ─── Real ALDI Stores Across All 5 Mainland AU Cities ────────────────────────

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

const STANDARD_ALDI_HOURS = [
  { weekday: 1, openMinute: 9 * 60, closeMinute: 20 * 60 },
  { weekday: 2, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 3, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 4, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 5, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 6, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
  { weekday: 7, openMinute: 8 * 60 + 30, closeMinute: 20 * 60 },
];

const ALDI_CITY_CONFIG: Partial<
  Record<
    AuCity,
    {
      stateUpper: AuStateUpper;
      stateLower: AuStateLower;
      defaultSuburb: string;
      defaultPostcode: string;
      bounds: { latMin: number; latMax: number; lonMin: number; lonMax: number };
      points: Array<[number, number]>;
    }
  >
> = {
  melbourne: {
    stateUpper: "VIC",
    stateLower: "vic",
    defaultSuburb: "Melbourne",
    defaultPostcode: "3000",
    bounds: { latMin: -38.30, latMax: -37.50, lonMin: 144.45, lonMax: 145.55 },
    points: [
      [-37.8136, 144.9631],
      [-37.7100, 144.9800],
      [-37.8200, 145.1800],
      [-37.9400, 145.1200],
      [-38.1200, 145.1400],
      [-37.8400, 144.7500],
    ],
  },
  sydney: {
    stateUpper: "NSW",
    stateLower: "nsw",
    defaultSuburb: "Sydney",
    defaultPostcode: "2000",
    bounds: { latMin: -34.18, latMax: -33.55, lonMin: 150.60, lonMax: 151.35 },
    points: [
      [-33.8688, 151.2093],
      [-33.7970, 151.1800],
      [-33.8150, 151.0000],
      [-33.7700, 150.8500],
      [-33.9200, 150.9200],
      [-34.0310, 151.0580],
    ],
  },
  brisbane: {
    stateUpper: "QLD",
    stateLower: "qld",
    defaultSuburb: "Brisbane",
    defaultPostcode: "4000",
    bounds: { latMin: -28.05, latMax: -27.05, lonMin: 152.65, lonMax: 153.55 },
    points: [
      [-27.4698, 153.0251],
      [-27.3200, 153.0200],
      [-27.5800, 153.0800],
      [-27.6200, 152.7600],
    ],
  },
  perth: {
    stateUpper: "WA",
    stateLower: "wa",
    defaultSuburb: "Perth",
    defaultPostcode: "6000",
    bounds: { latMin: -32.60, latMax: -31.45, lonMin: 115.60, lonMax: 116.25 },
    points: [
      [-31.9505, 115.8605],
      [-31.7450, 115.7700],
      [-32.0569, 115.7439],
      [-32.3500, 115.7500],
    ],
  },
  adelaide: {
    stateUpper: "SA",
    stateLower: "sa",
    defaultSuburb: "Adelaide",
    defaultPostcode: "5000",
    bounds: { latMin: -35.30, latMax: -34.55, lonMin: 138.45, lonMax: 138.85 },
    points: [
      [-34.9285, 138.6007],
      [-34.7600, 138.6400],
      [-35.0200, 138.5500],
    ],
  },
};

export async function fetchAldiCityStores(city: AuCity): Promise<MelbourneStore[]> {
  const cfg = ALDI_CITY_CONFIG[city];
  if (!cfg) return [];

  const byId = new Map<string, MelbourneStore>();

  for (const [lat, lon] of cfg.points) {
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
        if (!addr || (addr.regionIsoCode ?? "").toUpperCase() !== cfg.stateUpper) continue;
        const slat = Number(addr.latitude);
        const slon = Number(addr.longitude);
        const b = cfg.bounds;
        if (
          !Number.isFinite(slat) ||
          !Number.isFinite(slon) ||
          slat < b.latMin ||
          slat > b.latMax ||
          slon < b.lonMin ||
          slon > b.lonMax
        ) {
          continue;
        }
        const id = `aldi-${s.id}`;
        if (byId.has(id)) continue;

        const suburb = (addr.city ?? cfg.defaultSuburb).trim();
        byId.set(id, {
          id,
          retailer: "aldi",
          storeNo: s.id,
          name: suburb,
          streetAddress: (addr.address1 ?? s.name ?? "").trim(),
          suburb,
          state: cfg.stateLower,
          postcode: (addr.zipCode ?? cfg.defaultPostcode).trim(),
          latitude: slat,
          longitude: slon,
          phone: s.publicPhoneNumber?.trim() || undefined,
          hours: STANDARD_ALDI_HOURS,
          hasDedicatedBabyAisle: false,
          source: "aldi_api",
        });
      }
    } catch (err) {
      console.warn(`[aldi] ${city} store lookup (${lat},${lon}) failed:`, (err as Error).message);
    }
  }

  return [...byId.values()].sort((a, b) => a.suburb.localeCompare(b.suburb));
}

export async function fetchAldiMelbourneStores(): Promise<MelbourneStore[]> {
  return fetchAldiCityStores("melbourne");
}
