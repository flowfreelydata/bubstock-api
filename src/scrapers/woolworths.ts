import { singleflight } from "../cache.js";
import type {
  AuCity,
  AuStateLower,
  AuStateUpper,
  MelbourneStore,
  PriceEntry,
  RetailerFeedStatus,
  SpecialEntry,
  TradingHoursEntry,
} from "../types.js";

const BASE = "https://www.woolworths.com.au";
const SEARCH_URL = `${BASE}/apis/ui/Search/products`;
const STORE_LOCATOR_URL = `${BASE}/apis/ui/StoreLocator/Stores`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const MELB_LAT_MIN = -38.30;
const MELB_LAT_MAX = -37.50;
const MELB_LON_MIN = 144.45;
const MELB_LON_MAX = 145.55;

let sessionCookie = "";
let sessionExpiry = 0;

async function getSession(): Promise<string> {
  if (Date.now() < sessionExpiry && sessionCookie) return sessionCookie;
  return singleflight("woolworths:session", async () => {
    if (Date.now() < sessionExpiry && sessionCookie) return sessionCookie;
    try {
      const r = await fetch(BASE, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(12_000),
      });
      const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
      sessionCookie = raw.map((c) => c.split(";")[0]).join("; ");
      sessionExpiry = Date.now() + 5 * 60 * 1000;
    } catch (err) {
      console.warn("[woolworths] session prime failed:", (err as Error).message);
      sessionCookie = "";
      sessionExpiry = 0;
    }
    return sessionCookie;
  });
}

interface WoolworthsProduct {
  Stockcode?: number;
  Barcode?: string;
  Name?: string;
  DisplayName?: string;
  Brand?: string;
  Price?: number;
  WasPrice?: number;
  IsOnSpecial?: boolean;
  IsInStock?: boolean;
  IsAvailable?: boolean;
  CupString?: string;
  CupMeasure?: string;
  CupPrice?: number;
  PackageSize?: string;
  SmallImageFile?: string;
  MediumImageFile?: string;
  UrlFriendlyName?: string;
  PromotionEnd?: string;
}

interface WoolworthsResponse {
  Products?: Array<{ Products?: WoolworthsProduct[] }>;
  SearchResultsCount?: number;
}

export interface ScraperResult {
  entries: PriceEntry[];
  status: RetailerFeedStatus;
}

export async function searchWoolworthsPrices(
  productName: string,
  suburb: string,
  state = "VIC"
): Promise<ScraperResult> {
  const t0 = Date.now();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cookie = await getSession();
      const qs = new URLSearchParams({
        searchTerm: productName,
        pageSize: "20",
        pageNumber: "1",
        sortType: "TraderRelevance",
        isMobile: "false",
        isSpecial: "false",
      });

      const r = await fetch(`${SEARCH_URL}?${qs.toString()}`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Referer: `${BASE}/`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: AbortSignal.timeout(14_000),
      });

      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }

      const data = (await r.json()) as WoolworthsResponse;
      const entries: PriceEntry[] = [];
      const seen = new Set<number>();
      const nowIso = new Date().toISOString();

      for (const bundle of (data.Products ?? []).slice(0, 12)) {
        for (const p of bundle.Products ?? []) {
          if (!p.Price || !p.Stockcode) continue;
          if (seen.has(p.Stockcode)) continue;
          if (p.Price < 0.5 || p.Price > 350) continue;
          seen.add(p.Stockcode);

          const wasPrice =
            p.WasPrice && p.WasPrice > p.Price ? Number(p.WasPrice.toFixed(2)) : undefined;
          const savingsPercent = wasPrice
            ? Math.round(((wasPrice - p.Price) / wasPrice) * 100)
            : undefined;
          const slug = p.UrlFriendlyName ?? String(p.Stockcode);

          entries.push({
            retailer: "Woolworths",
            storeName: `Woolworths Online (${state.toUpperCase()})`,
            suburb,
            state: state.toUpperCase(),
            matchedName: (p.DisplayName ?? p.Name ?? productName).trim(),
            brand: p.Brand?.trim() || undefined,
            stockcode: String(p.Stockcode),
            barcode: p.Barcode?.trim() || undefined,
            price: Number(p.Price.toFixed(2)),
            wasPrice,
            savingsPercent,
            currency: "AUD",
            unit: p.CupString ?? p.CupMeasure ?? p.PackageSize ?? "",
            isOnSale: Boolean(p.IsOnSpecial || wasPrice),
            saleEndsAt: p.PromotionEnd ?? undefined,
            isInStock:
              typeof p.IsInStock === "boolean"
                ? p.IsInStock
                : typeof p.IsAvailable === "boolean"
                  ? p.IsAvailable
                  : undefined,
            imageUrl: p.MediumImageFile ?? p.SmallImageFile ?? undefined,
            productUrl: `${BASE}/shop/productdetails/${p.Stockcode}/${slug}`,
            lastUpdated: nowIso,
          });
        }
      }

      return {
        entries: entries.slice(0, 8),
        status: {
          retailer: "Woolworths",
          status: entries.length > 0 ? "live" : "no_match",
          count: Math.min(entries.length, 8),
          latencyMs: Date.now() - t0,
          note:
            entries.length > 0
              ? "Live Woolworths catalogue & online stock"
              : "No matching item found",
        },
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt === 0) {
        sessionCookie = "";
        sessionExpiry = 0;
        await new Promise((res) => setTimeout(res, 700));
        continue;
      }
      return {
        entries: [],
        status: {
          retailer: "Woolworths",
          status: "unavailable",
          count: 0,
          latencyMs: Date.now() - t0,
          note: `Feed unavailable (${msg.slice(0, 60)})`,
        },
      };
    }
  }

  return {
    entries: [],
    status: {
      retailer: "Woolworths",
      status: "unavailable",
      count: 0,
      latencyMs: Date.now() - t0,
      note: "Feed unavailable",
    },
  };
}

// ─── Real Woolworths Baby Specials ───────────────────────────────────────────

const SPECIAL_QUERIES: Array<{ term: string; category: SpecialEntry["category"] }> = [
  { term: "infant formula", category: "formula" },
  { term: "toddler milk", category: "formula" },
  { term: "baby food pouch", category: "pouch" },
  { term: "huggies nappies", category: "nappies" },
  { term: "farex baby cereal", category: "cereal" },
  { term: "little bellies baby snacks", category: "snack" },
];

const BABY_INCLUDE_RE =
  /\b(baby|infant|toddler|formula|napp(y|ies)|pouch|puree|farex|bellies|rafferty|only organic|bellamy|aptamil|karicare|a2|alula|nan|ollie|heinz|huggies|babylove|millie moon|tooshies|rascal|swimmers|rusk|teething|custard|yoghurt melts|rice cereal)\b/i;

export async function fetchWoolworthsBabySpecials(): Promise<SpecialEntry[]> {
  const cookie = await getSession();
  const seen = new Set<number>();
  const specials: SpecialEntry[] = [];
  const nowIso = new Date().toISOString();

  for (const { term, category } of SPECIAL_QUERIES) {
    try {
      const qs = new URLSearchParams({
        searchTerm: term,
        pageSize: "20",
        pageNumber: "1",
        sortType: "TraderRelevance",
        isMobile: "false",
        isSpecial: "true",
      });
      const r = await fetch(`${SEARCH_URL}?${qs.toString()}`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Referer: `${BASE}/`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) continue;
      const data = (await r.json()) as WoolworthsResponse;

      for (const bundle of data.Products ?? []) {
        for (const p of bundle.Products ?? []) {
          if (!p.Stockcode || !p.Price || !p.WasPrice) continue;
          if (p.WasPrice <= p.Price || seen.has(p.Stockcode)) continue;
          const savingsAmount = Number((p.WasPrice - p.Price).toFixed(2));
          const savingsPercent = Math.round((savingsAmount / p.WasPrice) * 100);
          if (savingsPercent < 5) continue;
          const displayName = (p.DisplayName ?? p.Name ?? "").trim();
          if (!BABY_INCLUDE_RE.test(displayName)) continue;

          seen.add(p.Stockcode);
          const slug = p.UrlFriendlyName ?? String(p.Stockcode);
          specials.push({
            id: `wow-${p.Stockcode}`,
            retailer: "Woolworths",
            name: displayName,
            brand: p.Brand?.trim() || undefined,
            category,
            price: Number(p.Price.toFixed(2)),
            wasPrice: Number(p.WasPrice.toFixed(2)),
            savingsAmount,
            savingsPercent,
            unit: p.CupString ?? p.CupMeasure ?? p.PackageSize ?? "",
            isInStock: typeof p.IsInStock === "boolean" ? p.IsInStock : undefined,
            imageUrl: p.MediumImageFile ?? p.SmallImageFile ?? undefined,
            productUrl: `${BASE}/shop/productdetails/${p.Stockcode}/${slug}`,
            saleEndsAt: p.PromotionEnd ?? undefined,
            lastUpdated: nowIso,
          });
        }
      }
    } catch (err) {
      console.warn(`[woolworths] specials query "${term}" failed:`, (err as Error).message);
    }
  }

  return specials.sort((a, b) => b.savingsPercent - a.savingsPercent);
}

// ─── Real Greater Melbourne Woolworths Stores ────────────────────────────────

interface WowRawStore {
  StoreNo?: string;
  Name?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  Suburb?: string;
  State?: string;
  Postcode?: string;
  Latitude?: string | number;
  Longitude?: string | number;
  Phone?: string;
  TradingHours?: Array<{ Day?: string; OpenHour?: string; TradingHourForDisplay?: string }>;
}

const DAY_TO_WEEKDAY: Record<string, number> = {
  sun: 1,
  mon: 2,
  tue: 3,
  wed: 4,
  thu: 5,
  fri: 6,
  sat: 7,
};

function parseWowHours(raw?: WowRawStore["TradingHours"]): TradingHoursEntry[] {
  const byDay = new Map<number, TradingHoursEntry>();
  for (const h of raw ?? []) {
    const disp = h.TradingHourForDisplay ?? "";
    const m = disp.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat):\s*(\d{4})-(\d{4})/i);
    if (!m) continue;
    const weekday = DAY_TO_WEEKDAY[m[1].toLowerCase()];
    if (!weekday) continue;
    const openH = Number(m[2].slice(0, 2));
    const openM = Number(m[2].slice(2, 4));
    const closeH = Number(m[3].slice(0, 2));
    const closeM = Number(m[3].slice(2, 4));
    const openMinute = openH * 60 + openM;
    const closeMinute = closeH === 0 && closeM === 0 ? 1439 : closeH * 60 + closeM;
    byDay.set(weekday, { weekday, openMinute, closeMinute });
  }
  return [...byDay.values()].sort((a, b) => a.weekday - b.weekday);
}

const CITY_STORE_GRIDS: Record<
  AuCity,
  {
    stateUpper: AuStateUpper;
    acceptedStates: string[];
    stateLower: AuStateLower;
    defaultSuburb: string;
    defaultPostcode: string;
    bounds: { latMin: number; latMax: number; lonMin: number; lonMax: number };
    grid: Array<[number, number]>;
  }
> = {
  melbourne: {
    stateUpper: "VIC",
    acceptedStates: ["VIC"],
    stateLower: "vic",
    defaultSuburb: "Melbourne",
    defaultPostcode: "3000",
    bounds: { latMin: -39.25, latMax: -33.95, lonMin: 140.95, lonMax: 150.05 },
    grid: [
      [-37.8136, 144.9631], // Melbourne CBD / North Melbourne
      [-37.7800, 144.8200], // Sunshine / Footscray / Braybrook / Caroline Springs
      [-37.8800, 144.7200], // Point Cook / Tarneit / Werribee / Hoppers Crossing
      [-37.6800, 144.9500], // Craigieburn / Epping / Broadmeadows / Coburg
      [-37.8200, 145.1800], // Box Hill / Ringwood / Doncaster / Knox
      [-37.9400, 145.0800], // Bayside / Moorabbin / Chadstone / Dandenong
      [-38.1200, 145.1800], // Frankston / Cranbourne / Mornington Peninsula
      [-38.1499, 144.3617], // Geelong / Surf Coast
      [-37.5622, 143.8503], // Ballarat
      [-36.7570, 144.2794], // Bendigo
      [-36.3833, 145.4000], // Shepparton
      [-38.3830, 142.4880], // Warrnambool
      [-38.1950, 146.5400], // Traralgon / Gippsland
      [-36.1214, 146.8881], // Wodonga
      [-34.1855, 142.1625], // Mildura
    ],
  },
  sydney: {
    stateUpper: "NSW",
    acceptedStates: ["NSW", "ACT"],
    stateLower: "nsw",
    defaultSuburb: "Sydney",
    defaultPostcode: "2000",
    bounds: { latMin: -37.55, latMax: -28.15, lonMin: 140.95, lonMax: 153.68 },
    grid: [
      [-33.8688, 151.2093], // Sydney CBD / Inner
      [-33.7970, 151.1800], // North Shore / Chatswood
      [-33.7200, 151.2800], // Northern Beaches
      [-33.7300, 150.9800], // Hills / Castle Hill
      [-33.8150, 151.0000], // Parramatta
      [-33.7700, 150.8200], // Penrith / Blacktown / Mt Druitt
      [-33.9200, 150.9200], // Liverpool / Fairfield
      [-34.0310, 151.0580], // Sutherland / Campbelltown
      [-34.4278, 150.8931], // Wollongong / Illawarra
      [-33.4269, 151.3417], // Central Coast / Gosford
      [-32.9283, 151.7817], // Newcastle / Hunter
      [-35.2809, 149.1300], // Canberra / Queanbeyan
      [-35.1082, 147.3598], // Wagga Wagga / Albury
      [-30.2963, 153.1135], // Coffs Harbour / Port Macquarie
      [-28.2000, 153.5400], // Tweed / Byron / Northern Rivers
      [-31.0927, 150.9320], // Tamworth / Dubbo
    ],
  },
  brisbane: {
    stateUpper: "QLD",
    acceptedStates: ["QLD"],
    stateLower: "qld",
    defaultSuburb: "Brisbane",
    defaultPostcode: "4000",
    bounds: { latMin: -29.20, latMax: -10.50, lonMin: 137.95, lonMax: 153.60 },
    grid: [
      [-27.4698, 153.0251], // Brisbane CBD
      [-27.3200, 153.0200], // North (Chermside / North Lakes)
      [-27.5800, 153.0800], // South (Sunnybank / Mt Gravatt)
      [-27.6200, 152.7600], // Ipswich / Springfield / West
      [-27.5300, 153.2500], // Redlands / Bayside
      [-27.7200, 153.1500], // Logan
      [-28.0167, 153.4000], // Gold Coast
      [-26.6500, 153.0667], // Sunshine Coast
      [-27.5598, 151.9507], // Toowoomba
      [-25.2882, 152.8535], // Hervey Bay / Bundaberg
      [-23.3791, 150.5100], // Rockhampton / Gladstone
      [-21.1411, 149.1860], // Mackay
      [-19.2590, 146.8169], // Townsville
      [-16.9186, 145.7781], // Cairns
    ],
  },
  perth: {
    stateUpper: "WA",
    acceptedStates: ["WA"],
    stateLower: "wa",
    defaultSuburb: "Perth",
    defaultPostcode: "6000",
    bounds: { latMin: -35.20, latMax: -13.60, lonMin: 112.90, lonMax: 129.05 },
    grid: [
      [-31.9505, 115.8605], // Perth CBD
      [-31.7450, 115.7700], // Joondalup / North
      [-31.8900, 116.0100], // Midland / East
      [-32.0569, 115.7439], // Fremantle / Cockburn
      [-32.1500, 115.9500], // Armadale / Canning
      [-32.3500, 115.7500], // Rockingham / Mandurah
      [-33.3271, 115.6414], // Bunbury / Busselton
      [-28.7774, 114.6150], // Geraldton
      [-35.0269, 117.8837], // Albany
      [-30.7490, 121.4660], // Kalgoorlie
      [-17.9614, 122.2359], // Broome / Pilbara
    ],
  },
  adelaide: {
    stateUpper: "SA",
    acceptedStates: ["SA", "NT"],
    stateLower: "sa",
    defaultSuburb: "Adelaide",
    defaultPostcode: "5000",
    bounds: { latMin: -38.10, latMax: -10.90, lonMin: 128.95, lonMax: 141.05 },
    grid: [
      [-34.9285, 138.6007], // Adelaide CBD
      [-34.7600, 138.6400], // Salisbury / Elizabeth / Gawler
      [-34.8600, 138.5200], // Port Adelaide / West
      [-35.0200, 138.5500], // Marion / Glenelg
      [-35.1400, 138.5000], // Noarlunga / South
      [-35.0600, 138.8600], // Adelaide Hills / Mt Barker / Murray Bridge
      [-35.5525, 138.6216], // Victor Harbor
      [-37.8284, 140.7804], // Mount Gambier
      [-33.0333, 137.5667], // Whyalla / Port Augusta / Port Pirie
      [-34.7240, 135.8586], // Port Lincoln
      [-12.4634, 130.8456], // Darwin / Palmerston (NT)
      [-23.6980, 133.8807], // Alice Springs (NT)
    ],
  },
  tasmania: {
    stateUpper: "TAS",
    acceptedStates: ["TAS"],
    stateLower: "tas",
    defaultSuburb: "Hobart",
    defaultPostcode: "7000",
    bounds: { latMin: -43.75, latMax: -39.50, lonMin: 143.80, lonMax: 148.55 },
    grid: [
      [-42.8821, 147.3272], // Hobart / Glenorchy / Kingston
      [-41.4332, 147.1441], // Launceston
      [-41.1789, 146.3594], // Devonport / Ulverstone
      [-41.0522, 145.9061], // Burnie / Wynyard
    ],
  },
};

export async function fetchWoolworthsCityStores(
  city: AuCity
): Promise<MelbourneStore[]> {
  const cfg = CITY_STORE_GRIDS[city];
  const cookie = await getSession();
  const byId = new Map<string, MelbourneStore>();
  const accepted = new Set(cfg.acceptedStates);

  const BATCH = 4;
  for (let i = 0; i < cfg.grid.length; i += BATCH) {
    const slice = cfg.grid.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async ([lat, lon]) => {
        try {
          const qs = new URLSearchParams({
            Max: "80",
            Division: "SUPERMARKETS",
            Facility: "",
            latitude: String(lat),
            longitude: String(lon),
          });
          const r = await fetch(`${STORE_LOCATOR_URL}?${qs.toString()}`, {
            headers: {
              "User-Agent": UA,
              Accept: "application/json",
              Referer: `${BASE}/shop/storelocator`,
              ...(cookie ? { Cookie: cookie } : {}),
            },
            signal: AbortSignal.timeout(12_000),
          });
          if (!r.ok) return;
          const data = (await r.json()) as { Stores?: WowRawStore[] };

          for (const s of data.Stores ?? []) {
            const rawSt = (s.State ?? "").toUpperCase();
            if (!s.StoreNo || !accepted.has(rawSt)) continue;
            const slat = Number(s.Latitude);
            const slon = Number(s.Longitude);
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
            const id = `woolworths-${s.StoreNo}`;
            if (byId.has(id)) continue;

            const addressParts = [s.AddressLine1, s.AddressLine2].filter(Boolean);
            const resolvedState: AuStateLower = rawSt === "ACT" ? "act" : cfg.stateLower;
            byId.set(id, {
              id,
              retailer: "woolworths",
              storeNo: s.StoreNo,
              name: (s.Name ?? s.Suburb ?? "Woolworths").trim(),
              streetAddress: addressParts.join(", ").trim(),
              suburb: (s.Suburb ?? cfg.defaultSuburb).trim(),
              state: resolvedState,
              postcode: (s.Postcode ?? cfg.defaultPostcode).trim(),
              latitude: slat,
              longitude: slon,
              phone: s.Phone?.trim() || undefined,
              hours: parseWowHours(s.TradingHours),
              hasDedicatedBabyAisle: true,
              source: "woolworths_api",
            });
          }
        } catch (err) {
          console.warn(`[woolworths] ${city} store grid (${lat},${lon}) failed:`, (err as Error).message);
        }
      })
    );
  }

  return [...byId.values()].sort((a, b) => a.suburb.localeCompare(b.suburb));
}

export async function fetchWoolworthsMelbourneStores(): Promise<MelbourneStore[]> {
  return fetchWoolworthsCityStores("melbourne");
}
