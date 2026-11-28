import { singleflight } from "../cache.js";
import type {
  AuCity,
  AuStateLower,
  AuStateUpper,
  MelbourneStore,
  PriceEntry,
  RetailerFeedStatus,
} from "../types.js";

const API_BASE = "https://www.igashop.com.au/api/storefront";
const WEB_BASE = "https://www.igashop.com.au";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Verified active IGA Shop store IDs across Australia (probed live from /api/storefront/stores)
// Note: Tasmania IGA stores are not yet onboarded on igashop.com.au (handled transparently below).
const DEFAULT_STORE_ID: Partial<Record<AuStateUpper, string>> = {
  VIC: "19071",  // Morgan's IGA (VIC)
  NSW: "32600",  // Ashcroft's IGA (NSW)
  QLD: "103318", // IGA Bundamba (QLD)
  WA: "48077",   // IGA Beechboro (WA)
  SA: "21024",   // South Plympton IGA (SA)
};

const CITY_BOUNDS: Record<
  AuCity,
  {
    stateUpper: AuStateUpper;
    acceptedStates: string[];
    stateLower: AuStateLower;
    defaultSuburb: string;
    latMin: number;
    latMax: number;
    lonMin: number;
    lonMax: number;
  }
> = {
  melbourne: { stateUpper: "VIC", acceptedStates: ["VIC"],        stateLower: "vic", defaultSuburb: "Melbourne", latMin: -39.25, latMax: -33.95, lonMin: 140.95, lonMax: 150.05 },
  sydney:    { stateUpper: "NSW", acceptedStates: ["NSW", "ACT"], stateLower: "nsw", defaultSuburb: "Sydney",    latMin: -37.55, latMax: -28.15, lonMin: 140.95, lonMax: 153.68 },
  brisbane:  { stateUpper: "QLD", acceptedStates: ["QLD"],        stateLower: "qld", defaultSuburb: "Brisbane",  latMin: -29.20, latMax: -10.50, lonMin: 137.95, lonMax: 153.60 },
  perth:     { stateUpper: "WA",  acceptedStates: ["WA"],         stateLower: "wa",  defaultSuburb: "Perth",     latMin: -35.20, latMax: -13.60, lonMin: 112.90, lonMax: 129.05 },
  adelaide:  { stateUpper: "SA",  acceptedStates: ["SA", "NT"],   stateLower: "sa",  defaultSuburb: "Adelaide",  latMin: -38.10, latMax: -10.90, lonMin: 128.95, lonMax: 141.05 },
  tasmania:  { stateUpper: "TAS", acceptedStates: ["TAS"],        stateLower: "tas", defaultSuburb: "Hobart",    latMin: -43.75, latMax: -39.50, lonMin: 143.80, lonMax: 148.55 },
};

interface IgaProduct {
  sku?: string;
  name?: string;
  brand?: string;
  available?: boolean;
  price?: string;
  priceNumeric?: number;
  wasPrice?: string;
  wasPriceNumeric?: number;
  pricePerUnit?: string;
  unitOfSize?: { size?: number; abbreviation?: string };
  image?: { cell?: string; default?: string };
  tprPrice?: Array<{ priceNumeric?: number }>;
}

export interface IgaScraperResult {
  entries: PriceEntry[];
  status: RetailerFeedStatus;
}

export async function searchIgaPrices(
  productName: string,
  suburb: string,
  state: AuStateUpper = "VIC"
): Promise<IgaScraperResult> {
  const t0 = Date.now();
  const storeId = DEFAULT_STORE_ID[state];
  if (!storeId) {
    return {
      entries: [],
      status: {
        retailer: "IGA",
        status: "unavailable",
        count: 0,
        latencyMs: 0,
        note: `IGA Shop online not active in ${state} — check local IGA in-store`,
      },
    };
  }

  try {
    const qs = new URLSearchParams({
      q: productName,
      take: "10",
      skip: "0",
    });
    const r = await fetch(`${API_BASE}/stores/${storeId}/search?${qs.toString()}`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: `${WEB_BASE}/`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { items?: IgaProduct[] };

    const nowIso = new Date().toISOString();
    const entries: PriceEntry[] = [];

    for (const item of (data.items ?? []).slice(0, 8)) {
      const price = item.priceNumeric;
      if (!price || !Number.isFinite(price) || price < 0.5 || price > 350) continue;

      const was =
        item.wasPriceNumeric && item.wasPriceNumeric > price
          ? Number(item.wasPriceNumeric.toFixed(2))
          : undefined;
      const savingsPercent = was
        ? Math.round(((was - price) / was) * 100)
        : undefined;

      const sizeSuffix =
        item.unitOfSize?.size && item.unitOfSize?.abbreviation
          ? ` ${item.unitOfSize.size}${item.unitOfSize.abbreviation}`
          : "";
      const rawName = (item.name ?? productName).trim();
      const matchedName =
        sizeSuffix && !rawName.toLowerCase().includes(`${item.unitOfSize?.size}`)
          ? `${rawName}${sizeSuffix}`
          : rawName;

      const slug = rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      entries.push({
        retailer: "IGA",
        storeName: `IGA Online (${state})`,
        suburb,
        state,
        matchedName,
        brand: item.brand?.trim() || undefined,
        stockcode: item.sku,
        price: Number(price.toFixed(2)),
        wasPrice: was,
        savingsPercent,
        currency: "AUD",
        unit: item.pricePerUnit ?? sizeSuffix.trim(),
        isOnSale: Boolean(was),
        isInStock: typeof item.available === "boolean" ? item.available : undefined,
        imageUrl: item.image?.default ?? item.image?.cell ?? undefined,
        productUrl: item.sku ? `${WEB_BASE}/product/${slug}-${item.sku}` : undefined,
        lastUpdated: nowIso,
      });
    }

    return {
      entries,
      status: {
        retailer: "IGA",
        status: entries.length > 0 ? "live" : "no_match",
        count: entries.length,
        latencyMs: Date.now() - t0,
        note:
          entries.length > 0
            ? `Live IGA ${state} catalogue & store availability`
            : "No matching IGA line",
      },
    };
  } catch (err) {
    return {
      entries: [],
      status: {
        retailer: "IGA",
        status: "unavailable",
        count: 0,
        latencyMs: Date.now() - t0,
        note: `Feed unavailable (${(err as Error).message.slice(0, 60)})`,
      },
    };
  }
}

// ─── Real Greater Melbourne & Greater Sydney IGA Stores ──────────────────────

interface IgaRawStore {
  retailerStoreId?: string;
  name?: string;
  status?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  countyProvinceState?: string;
  postCode?: string;
  phone?: string;
  location?: { latitude?: number; longitude?: number };
}

let allIgaStoresCache: IgaRawStore[] | null = null;
let allIgaStoresExpiry = 0;

async function fetchAllIgaRaw(): Promise<IgaRawStore[]> {
  if (allIgaStoresCache && Date.now() < allIgaStoresExpiry) return allIgaStoresCache;
  return singleflight("iga:stores:all", async () => {
    if (allIgaStoresCache && Date.now() < allIgaStoresExpiry) return allIgaStoresCache;
    try {
      const r = await fetch(`${API_BASE}/stores`, {
        headers: { "User-Agent": UA, Accept: "application/json", Referer: `${WEB_BASE}/` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) return allIgaStoresCache ?? [];
      const data = (await r.json()) as { items?: IgaRawStore[] };
      allIgaStoresCache = data.items ?? [];
      allIgaStoresExpiry = Date.now() + 12 * 60 * 60 * 1000;
      return allIgaStoresCache;
    } catch (err) {
      console.warn("[iga] stores fetch failed:", (err as Error).message);
      return allIgaStoresCache ?? [];
    }
  });
}

export async function fetchIgaCityStores(
  city: AuCity
): Promise<MelbourneStore[]> {
  const b = CITY_BOUNDS[city];
  const raw = await fetchAllIgaRaw();
  const byId = new Map<string, MelbourneStore>();

  const accepted = new Set(b.acceptedStates);
  for (const s of raw) {
    if ((s.status ?? "").toLowerCase() !== "active") continue;
    const rawState = (s.countyProvinceState ?? "").toUpperCase();
    if (!accepted.has(rawState)) continue;
    const lat = Number(s.location?.latitude);
    const lon = Number(s.location?.longitude);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < b.latMin ||
      lat > b.latMax ||
      lon < b.lonMin ||
      lon > b.lonMax
    ) {
      continue;
    }
    const id = `iga-${s.retailerStoreId ?? `${Math.round(lat * 10000)}-${Math.round(lon * 10000)}`}`;
    if (byId.has(id)) continue;

    const streetAddress = [s.addressLine1, s.addressLine2]
      .filter(Boolean)
      .join(", ")
      .replace(/,\s*$/, "")
      .trim();

    byId.set(id, {
      id,
      retailer: "iga",
      storeNo: s.retailerStoreId,
      name: (s.name ?? s.city ?? "IGA").trim(),
      streetAddress,
      suburb: (s.city ?? b.defaultSuburb).trim(),
      state: rawState === "ACT" ? "act" : b.stateLower,
      postcode: (s.postCode ?? "").trim(),
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lon.toFixed(6)),
      phone: s.phone?.trim() || undefined,
      hours: [],
      hasDedicatedBabyAisle: false,
      source: "iga_api",
    });
  }

  return [...byId.values()].sort((a, b2) => a.suburb.localeCompare(b2.suburb));
}
