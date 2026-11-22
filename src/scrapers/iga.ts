import type { MelbourneStore, PriceEntry, RetailerFeedStatus } from "../types.js";

const API_BASE = "https://www.igashop.com.au/api/storefront";
const WEB_BASE = "https://www.igashop.com.au";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Verified active IGA Shop store IDs for VIC (Melbourne) and NSW (Sydney)
const DEFAULT_STORE_ID: Record<"VIC" | "NSW", string> = {
  VIC: "19071", // Morgan's IGA (VIC)
  NSW: "32600", // Ashcroft's IGA (NSW)
};

const CITY_BOUNDS = {
  melbourne: { stateUpper: "VIC", stateLower: "vic" as const, latMin: -38.30, latMax: -37.50, lonMin: 144.45, lonMax: 145.55 },
  sydney: { stateUpper: "NSW", stateLower: "nsw" as const, latMin: -34.18, latMax: -33.55, lonMin: 150.60, lonMax: 151.35 },
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
  state: "VIC" | "NSW" = "VIC"
): Promise<IgaScraperResult> {
  const t0 = Date.now();
  const storeId = DEFAULT_STORE_ID[state] ?? DEFAULT_STORE_ID.VIC;

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
  try {
    const r = await fetch(`${API_BASE}/stores`, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: `${WEB_BASE}/` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { items?: IgaRawStore[] };
    allIgaStoresCache = data.items ?? [];
    allIgaStoresExpiry = Date.now() + 12 * 60 * 60 * 1000;
    return allIgaStoresCache;
  } catch (err) {
    console.warn("[iga] stores fetch failed:", (err as Error).message);
    return [];
  }
}

export async function fetchIgaCityStores(
  city: "melbourne" | "sydney"
): Promise<MelbourneStore[]> {
  const b = CITY_BOUNDS[city];
  const raw = await fetchAllIgaRaw();
  const byId = new Map<string, MelbourneStore>();

  for (const s of raw) {
    if ((s.status ?? "").toLowerCase() !== "active") continue;
    if ((s.countyProvinceState ?? "").toUpperCase() !== b.stateUpper) continue;
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
      suburb: (s.city ?? (city === "sydney" ? "Sydney" : "Melbourne")).trim(),
      state: b.stateLower,
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
