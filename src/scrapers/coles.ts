import type { PriceEntry, RetailerFeedStatus, SpecialEntry } from "../types.js";

const BASE = "https://www.coles.com.au";
const IMG_BASE = "https://productimages.coles.com.au/productimages";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

interface ColesSession {
  cookie: string;
  buildId: string | null;
  expiry: number;
}

let _session: ColesSession = { cookie: "", buildId: null, expiry: 0 };

async function getSession(): Promise<ColesSession> {
  if (Date.now() < _session.expiry && _session.buildId) return _session;
  try {
    const r = await fetch(BASE, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
      },
      signal: AbortSignal.timeout(12_000),
    });

    const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    const cookie = raw.map((c) => c.split(";")[0]).join("; ");
    const html = await r.text();
    const match = html.match(/"buildId":"([^"]+)"/);
    const buildId = match?.[1] ?? null;

    _session = { cookie, buildId, expiry: Date.now() + 5 * 60 * 1000 };
  } catch (err) {
    console.warn("[coles] session prime failed:", (err as Error).message);
    _session = { cookie: "", buildId: null, expiry: Date.now() + 60_000 };
  }
  return _session;
}

interface ColesProduct {
  id?: number;
  name?: string;
  brand?: string;
  size?: string;
  availability?: boolean;
  imageUris?: Array<{ uri?: string }>;
  pricing?: {
    now?: number;
    was?: number;
    saveAmount?: number;
    savePercent?: number;
    comparable?: string;
    promotionType?: string;
  };
}

interface ColesNextResponse {
  pageProps?: {
    searchResults?: {
      results?: ColesProduct[];
      noOfResults?: number;
    };
  };
}

function toEntry(
  item: ColesProduct,
  suburb: string,
  state: string,
  nowIso: string
): PriceEntry | null {
  const price = item.pricing?.now;
  if (!price || price < 0.5 || price > 350) return null;
  const was = item.pricing?.was && item.pricing.was > price ? item.pricing.was : undefined;
  const savingsPercent = was
    ? Math.round(((was - price) / was) * 100)
    : item.pricing?.savePercent && item.pricing.savePercent > 0
      ? Math.round(item.pricing.savePercent)
      : undefined;

  const fullName = [item.brand, item.name, item.size]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const imgUri = item.imageUris?.[0]?.uri;
  const imageUrl = imgUri
    ? imgUri.startsWith("http")
      ? imgUri
      : `${IMG_BASE}${imgUri}`
    : undefined;

  const slug = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const productUrl = item.id ? `${BASE}/product/${slug}-${item.id}` : undefined;

  return {
    retailer: "Coles",
    storeName: `Coles Online (${state.toUpperCase()})`,
    suburb,
    state: state.toUpperCase(),
    matchedName: fullName || (item.name ?? "Coles Product"),
    brand: item.brand?.trim() || undefined,
    stockcode: item.id ? String(item.id) : undefined,
    price: Number(price.toFixed(2)),
    wasPrice: was ? Number(was.toFixed(2)) : undefined,
    savingsPercent,
    currency: "AUD",
    unit: item.pricing?.comparable ?? item.size ?? "",
    isOnSale: Boolean(was || item.pricing?.promotionType === "SPECIAL"),
    isInStock: typeof item.availability === "boolean" ? item.availability : undefined,
    imageUrl,
    productUrl,
    lastUpdated: nowIso,
  };
}

export interface ColesScraperResult {
  entries: PriceEntry[];
  status: RetailerFeedStatus;
}

export async function searchColesPrices(
  productName: string,
  suburb: string,
  state = "VIC"
): Promise<ColesScraperResult> {
  const t0 = Date.now();
  const { cookie, buildId } = await getSession();

  if (!buildId) {
    return {
      entries: [],
      status: {
        retailer: "Coles",
        status: "unavailable",
        count: 0,
        latencyMs: Date.now() - t0,
        note: "Coles session unavailable right now",
      },
    };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sess = attempt === 0 ? { cookie, buildId } : await getSession();
      if (!sess.buildId) break;

      const qs = new URLSearchParams({ q: productName });
      const nextUrl = `${BASE}/_next/data/${sess.buildId}/en/search/products.json?${qs.toString()}`;
      const r = await fetch(nextUrl, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          "Accept-Language": "en-AU,en;q=0.9",
          Referer: `${BASE}/`,
          ...(sess.cookie ? { Cookie: sess.cookie } : {}),
        },
        signal: AbortSignal.timeout(14_000),
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ColesNextResponse;

      const nowIso = new Date().toISOString();
      const raw = data?.pageProps?.searchResults?.results ?? [];
      const entries = raw
        .map((item) => toEntry(item, suburb, state, nowIso))
        .filter((e): e is PriceEntry => e !== null)
        .slice(0, 8);

      return {
        entries,
        status: {
          retailer: "Coles",
          status: entries.length > 0 ? "live" : "no_match",
          count: entries.length,
          latencyMs: Date.now() - t0,
          note:
            entries.length > 0
              ? "Live Coles catalogue & online availability"
              : "No matching item found",
        },
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt === 0) {
        _session.expiry = 0;
        await new Promise((res) => setTimeout(res, 700));
        continue;
      }
      return {
        entries: [],
        status: {
          retailer: "Coles",
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
      retailer: "Coles",
      status: "unavailable",
      count: 0,
      latencyMs: Date.now() - t0,
      note: "Feed unavailable",
    },
  };
}

// ─── Real Coles Baby Specials ────────────────────────────────────────────────

const COLES_SPECIAL_QUERIES: Array<{ term: string; category: SpecialEntry["category"] }> = [
  { term: "infant formula", category: "formula" },
  { term: "baby food pouch", category: "pouch" },
  { term: "huggies nappies", category: "nappies" },
  { term: "farex baby cereal", category: "cereal" },
  { term: "little bellies", category: "snack" },
];

const COLES_BABY_RE =
  /\b(baby|infant|toddler|formula|napp(y|ies)|pouch|puree|farex|bellies|rafferty|only organic|bellamy|aptamil|karicare|a2|alula|nan|heinz|huggies|babylove|cub|rascal|swimmers|rusk|teething|custard)\b/i;

export async function fetchColesBabySpecials(): Promise<SpecialEntry[]> {
  const { cookie, buildId } = await getSession();
  if (!buildId) return [];

  const seen = new Set<number>();
  const specials: SpecialEntry[] = [];
  const nowIso = new Date().toISOString();

  for (const { term, category } of COLES_SPECIAL_QUERIES) {
    try {
      const qs = new URLSearchParams({ q: term });
      const r = await fetch(
        `${BASE}/_next/data/${buildId}/en/search/products.json?${qs.toString()}`,
        {
          headers: {
            "User-Agent": UA,
            Accept: "application/json",
            "Accept-Language": "en-AU,en;q=0.9",
            Referer: `${BASE}/`,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          signal: AbortSignal.timeout(12_000),
        }
      );
      if (!r.ok) continue;
      const data = (await r.json()) as ColesNextResponse;

      for (const item of data?.pageProps?.searchResults?.results ?? []) {
        const price = item.pricing?.now;
        const was = item.pricing?.was;
        if (!item.id || !price || !was || was <= price || seen.has(item.id)) continue;

        const savingsAmount = Number((was - price).toFixed(2));
        const savingsPercent = Math.round((savingsAmount / was) * 100);
        if (savingsPercent < 5) continue;

        const fullName = [item.brand, item.name, item.size]
          .filter((v): v is string => Boolean(v && v.trim()))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!COLES_BABY_RE.test(fullName)) continue;

        seen.add(item.id);
        const imgUri = item.imageUris?.[0]?.uri;
        const imageUrl = imgUri
          ? imgUri.startsWith("http")
            ? imgUri
            : `${IMG_BASE}${imgUri}`
          : undefined;
        const slug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

        specials.push({
          id: `coles-${item.id}`,
          retailer: "Coles",
          name: fullName,
          brand: item.brand?.trim() || undefined,
          category,
          price: Number(price.toFixed(2)),
          wasPrice: Number(was.toFixed(2)),
          savingsAmount,
          savingsPercent,
          unit: item.pricing?.comparable ?? item.size ?? "",
          isInStock: typeof item.availability === "boolean" ? item.availability : undefined,
          imageUrl,
          productUrl: `${BASE}/product/${slug}-${item.id}`,
          lastUpdated: nowIso,
        });
      }
    } catch (err) {
      console.warn(`[coles] specials query "${term}" failed:`, (err as Error).message);
    }
  }

  return specials.sort((a, b) => b.savingsPercent - a.savingsPercent);
}
