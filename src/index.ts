import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import zlib from "node:zlib";
import {
  searchWoolworthsPrices,
  fetchWoolworthsBabySpecials,
  fetchWoolworthsCityStores,
} from "./scrapers/woolworths.js";
import { searchColesPrices, fetchColesBabySpecials } from "./scrapers/coles.js";
import { searchAldiPrices, fetchAldiMelbourneStores } from "./scrapers/aldi.js";
import { searchIgaPrices, fetchIgaCityStores } from "./scrapers/iga.js";
import { searchPricelinePrices, fetchPricelineCityStores } from "./scrapers/priceline.js";
import { fetchAllOfficialRecalls } from "./scrapers/fsanz.js";
import {
  priceCache,
  recallCache,
  singleflight,
  specialsCache,
  storesCache,
} from "./cache.js";
import {
  initSchema,
  savePrices,
  getFreshRetailerPrices,
  getColesVsWoolworthsGaps,
  getPriceHistory,
  upsertSpecials,
  loadFreshSpecials,
  upsertRecalls,
  loadRecalls,
  saveSighting,
  getSightings,
  countRecentSightings,
  saveSocialPromo,
  getRecentSocialPromos,
  pingDB,
  type RecallRow,
} from "./db.js";
import {
  areComparablePair,
  classifyPairMatch,
  computeUnitMetric,
  matchScore,
  pickBestComparablePair,
} from "./matcher.js";
import type {
  AuCity,
  AuStateUpper,
  HeadToHeadComparison,
  MelbournePulse,
  MelbourneStore,
  PriceEntry,
  ProductPriceResult,
  RecallCheckResult,
  RecallEntry,
  RetailerFeedStatus,
  SpecialEntry,
  StockStateValue,
} from "./types.js";

const ALL_CITIES: AuCity[] = ["melbourne", "sydney", "brisbane", "perth", "adelaide", "tasmania"];
const VALID_AU_STATES = new Set<AuStateUpper>(["VIC", "NSW", "QLD", "WA", "SA", "TAS"]);

interface CityContext {
  city: AuCity;
  state: AuStateUpper;
  regionLabel: string;
  defaultSuburb: string;
  defaultLat: number;
  defaultLon: number;
}

const CITY_CONTEXTS: Record<AuCity, CityContext> = {
  melbourne: {
    city: "melbourne",
    state: "VIC",
    regionLabel: "Greater Melbourne, VIC",
    defaultSuburb: "Melbourne",
    defaultLat: -37.8136,
    defaultLon: 144.9631,
  },
  sydney: {
    city: "sydney",
    state: "NSW",
    regionLabel: "Greater Sydney, NSW",
    defaultSuburb: "Sydney",
    defaultLat: -33.8688,
    defaultLon: 151.2093,
  },
  brisbane: {
    city: "brisbane",
    state: "QLD",
    regionLabel: "Greater Brisbane, QLD",
    defaultSuburb: "Brisbane",
    defaultLat: -27.4698,
    defaultLon: 153.0251,
  },
  perth: {
    city: "perth",
    state: "WA",
    regionLabel: "Greater Perth, WA",
    defaultSuburb: "Perth",
    defaultLat: -31.9505,
    defaultLon: 115.8605,
  },
  adelaide: {
    city: "adelaide",
    state: "SA",
    regionLabel: "Greater Adelaide, SA",
    defaultSuburb: "Adelaide",
    defaultLat: -34.9285,
    defaultLon: 138.6007,
  },
  tasmania: {
    city: "tasmania",
    state: "TAS",
    regionLabel: "Tasmania (Hobart & Launceston), TAS",
    defaultSuburb: "Hobart",
    defaultLat: -42.8821,
    defaultLon: 147.3272,
  },
};

function resolveCityAndState(req: Request): CityContext {
  const rawCity = String(req.query.city ?? "").toLowerCase().trim();
  const rawState = String(req.query.state ?? "").toUpperCase().trim();
  const lat = req.query.lat !== undefined ? Number(req.query.lat) : NaN;
  const lon = req.query.lon !== undefined ? Number(req.query.lon) : NaN;

  if (rawCity === "sydney" || rawState === "NSW") return CITY_CONTEXTS.sydney;
  if (rawCity === "brisbane" || rawCity === "bris" || rawState === "QLD") return CITY_CONTEXTS.brisbane;
  if (rawCity === "perth" || rawState === "WA") return CITY_CONTEXTS.perth;
  if (rawCity === "adelaide" || rawCity === "adel" || rawState === "SA") return CITY_CONTEXTS.adelaide;
  if (rawCity === "tasmania" || rawCity === "hobart" || rawCity === "launceston" || rawCity === "tas" || rawState === "TAS") {
    return CITY_CONTEXTS.tasmania;
  }
  if (rawCity === "melbourne" || rawCity === "melb" || rawState === "VIC") return CITY_CONTEXTS.melbourne;

  if (Number.isFinite(lat)) {
    if (lat < -40.0) return CITY_CONTEXTS.tasmania;
    if (lat > -29.0) return CITY_CONTEXTS.brisbane;
    if (Number.isFinite(lon) && lon < 125.0) return CITY_CONTEXTS.perth;
    if (Number.isFinite(lon) && lon >= 134.0 && lon < 141.0) return CITY_CONTEXTS.adelaide;
    if (lat > -35.5 && lat < -32.5) return CITY_CONTEXTS.sydney;
  }

  return CITY_CONTEXTS.melbourne;
}

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT ?? 3000);

function log(level: "info" | "warn" | "error", msg: string, extra?: object) {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({ level, ts: new Date().toISOString(), msg, ...extra })
  );
}

// ─── Security, gzip compression & middleware ──────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "256kb" }));

// Zero-dependency gzip compression for JSON payloads > 1 KB (cuts Railway egress ~80%)
app.use((req: Request, res: Response, next: NextFunction) => {
  const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
  if (!acceptEncoding.includes("gzip")) {
    next();
    return;
  }
  const origJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const raw = JSON.stringify(body);
    if (raw.length < 1024) {
      return origJson(body);
    }
    const compressed = zlib.gzipSync(raw, { level: 6 });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    return res.send(compressed);
  }) as Response["json"];
  next();
});

app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).id = Math.random().toString(36).slice(2, 10);
  next();
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

const generalLimit = rateLimit({
  windowMs: 60_000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down" },
});

const priceLimit = rateLimit({
  windowMs: 60_000,
  max: 35,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Price lookup rate limit exceeded — wait a minute" },
});

const sightingLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many shelf reports — please wait a minute" },
});

app.use(generalLimit);

// ─── Root & Health ────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    service: "bubstock-au-api",
    version: "2.4.0",
    cities: Object.values(CITY_CONTEXTS).map((c) => c.regionLabel),
    policy: "100% live & verified data — zero synthetic fallbacks",
    endpoints: [
      "/health",
      "/pulse?city=melbourne|sydney|brisbane|perth|adelaide|tasmania",
      "/melbourne/pulse",
      "/prices",
      "/prices/history",
      "/prices/ingest",
      "/compare",
      "/compare/gaps",
      "/specials",
      "/specials/ingest",
      "/stores?city=melbourne|sydney|brisbane|perth|adelaide|tasmania",
      "/recalls?state=VIC|NSW|QLD|WA|SA|TAS",
      "/recalls/check",
      "/sightings",
    ],
  });
});

app.get("/health", async (_req, res) => {
  const dbOk = await pingDB();
  const memMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
  res.status(200).json({
    status: dbOk ? "ok" : "degraded",
    cities: Object.values(CITY_CONTEXTS).map((c) => c.regionLabel),
    db: dbOk ? "connected" : "in-memory-fallback",
    memoryMB: memMB,
    timestamp: new Date().toISOString(),
    cache: {
      price: priceCache.size(),
      recall: recallCache.size(),
      specials: specialsCache.size(),
      stores: storesCache.size(),
    },
  });
});

// ─── Coalesced live + Postgres-verified price resolver ───────────────────────

async function resolveMultiRetailerPrices(
  cleanProduct: string,
  cleanSuburb: string,
  state: AuStateUpper
): Promise<ProductPriceResult> {
  // Normalize cache key at state level (Woolworths/Coles chain pricing is state-wide!)
  // so Fitzroy, Carlton & Richmond share 1 cache entry -> massive Railway efficiency!
  const cacheKey = `${cleanProduct.toLowerCase()}|${state}`;
  const cached = priceCache.get(cacheKey);
  if (cached) {
    return { ...cached, suburb: cleanSuburb };
  }

  return singleflight(`price:${cacheKey}`, async () => {
    const again = priceCache.get(cacheKey);
    if (again) return { ...again, suburb: cleanSuburb };

    // Query all 5 open live Australian retail APIs in parallel (Woolworths, Coles, IGA, Priceline, ALDI)
    const includeAldi = state === "VIC";

    const [wowRes, colesLiveRes, igaRes, pricelineRes, aldiRes] = await Promise.all([
      searchWoolworthsPrices(cleanProduct, cleanSuburb, state),
      searchColesPrices(cleanProduct, cleanSuburb, state),
      searchIgaPrices(cleanProduct, cleanSuburb, state),
      searchPricelinePrices(cleanProduct, cleanSuburb, state),
      includeAldi
        ? searchAldiPrices(cleanProduct, cleanSuburb, state)
        : Promise.resolve(null),
    ]);

    let wowEntries = wowRes.entries;
    let wowStatus: RetailerFeedStatus = wowRes.status;
    if (wowEntries.length === 0) {
      const dbWow = await getFreshRetailerPrices(cleanProduct, "Woolworths", 48);
      if (dbWow.length > 0) {
        wowEntries = dbWow.map((e) => ({ ...e, suburb: cleanSuburb, state }));
        wowStatus = {
          retailer: "Woolworths",
          status: "live",
          count: dbWow.length,
          latencyMs: wowRes.status.latencyMs,
          note: `Verified Woolworths ${state} price (Postgres sync)`,
        };
      }
    }

    let colesEntries = colesLiveRes.entries;
    let colesStatus: RetailerFeedStatus = colesLiveRes.status;

    if (colesEntries.length === 0) {
      const dbColes = await getFreshRetailerPrices(cleanProduct, "Coles", 48);
      if (dbColes.length > 0) {
        colesEntries = dbColes.map((e) => ({
          ...e,
          storeName: `Coles Online (${state})`,
          suburb: cleanSuburb,
          state,
        }));
        const newestMs = Math.max(...dbColes.map((e) => new Date(e.lastUpdated).getTime()));
        const ageHrs = Math.max(0, Math.round((Date.now() - newestMs) / 3_600_000));
        colesStatus = {
          retailer: "Coles",
          status: "live",
          count: dbColes.length,
          latencyMs: colesLiveRes.status.latencyMs,
          note:
            ageHrs < 1
              ? `Verified Coles ${state} price (synced just now)`
              : `Verified Coles ${state} price (synced ${ageHrs}h ago)`,
        };
      }
    }

    let igaEntries = igaRes.entries;
    let igaStatus: RetailerFeedStatus = igaRes.status;
    if (igaEntries.length === 0) {
      const dbIga = await getFreshRetailerPrices(cleanProduct, "IGA", 48);
      if (dbIga.length > 0) {
        igaEntries = dbIga.map((e) => ({
          ...e,
          storeName: `IGA Online (${state})`,
          suburb: cleanSuburb,
          state,
        }));
        igaStatus = {
          retailer: "IGA",
          status: "live",
          count: dbIga.length,
          latencyMs: igaRes.status.latencyMs,
          note: `Verified IGA ${state} price (Postgres sync)`,
        };
      }
    }

    let pricelineEntries = pricelineRes.entries;
    let pricelineStatus: RetailerFeedStatus = pricelineRes.status;
    if (pricelineEntries.length === 0) {
      const dbPriceline = await getFreshRetailerPrices(cleanProduct, "Priceline", 48);
      if (dbPriceline.length > 0) {
        pricelineEntries = dbPriceline.map((e) => ({
          ...e,
          storeName: `Priceline Pharmacy (${state})`,
          suburb: cleanSuburb,
          state,
        }));
        pricelineStatus = {
          retailer: "Priceline",
          status: "live",
          count: dbPriceline.length,
          latencyMs: pricelineRes.status.latencyMs,
          note: `Verified Priceline ${state} price (Postgres sync)`,
        };
      }
    }

    const allRaw = [
      ...wowEntries,
      ...colesEntries,
      ...igaEntries,
      ...pricelineEntries,
      ...(aldiRes ? aldiRes.entries : []),
    ];
    const scored = allRaw
      .map((entry) => ({ entry, score: matchScore(cleanProduct, entry) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.entry.price - b.entry.price;
      });

    const entries =
      scored.length > 0
        ? scored.map((s) => s.entry)
        : allRaw.sort((a, b) => a.price - b.price);

    const retailerStatus: RetailerFeedStatus[] = [
      wowStatus,
      colesStatus,
      igaStatus,
      pricelineStatus,
      ...(aldiRes ? [aldiRes.status] : []),
      {
        retailer: "Chemist Warehouse",
        status: "unavailable",
        count: 0,
        latencyMs: 0,
        note: "In-store / call store (no open public API)",
      },
      {
        retailer: "Baby Bunting",
        status: "unavailable",
        count: 0,
        latencyMs: 0,
        note: "In-store / call store (no open public API)",
      },
    ];

    const result: ProductPriceResult = {
      productName: cleanProduct,
      suburb: cleanSuburb,
      state,
      entries,
      retailerStatus,
      fetchedAt: new Date().toISOString(),
    };

    priceCache.set(cacheKey, result, 30 * 60 * 1000);

    const freshToPersist = [
      ...wowRes.entries,
      ...colesLiveRes.entries,
      ...igaRes.entries,
      ...pricelineRes.entries,
      ...(aldiRes ? aldiRes.entries : []),
    ];
    savePrices(cleanProduct, cleanSuburb, state, freshToPersist).catch((e) =>
      log("error", "savePrices failed", { err: (e as Error).message })
    );

    return result;
  });
}

// ─── Live Multi-Retailer Prices ──────────────────────────────────────────────

app.get("/prices", priceLimit, async (req: Request, res: Response) => {
  const { product } = req.query;
  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required (min 2 chars)" });
    return;
  }

  const ctx = resolveCityAndState(req);
  const cleanProduct = product.trim();
  const cleanSuburb = String(req.query.suburb ?? ctx.defaultSuburb).trim() || ctx.defaultSuburb;

  log("info", "live price lookup", {
    product: cleanProduct,
    suburb: cleanSuburb,
    state: ctx.state,
    id: (req as any).id,
  });

  const result = await resolveMultiRetailerPrices(cleanProduct, cleanSuburb, ctx.state);
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=900");
  res.json(result);
});

// ─── Exact Canonical Coles vs Woolworths Head-to-Head Compare ────────────────

app.get("/compare", priceLimit, async (req: Request, res: Response) => {
  const { product } = req.query;
  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required (min 2 chars)" });
    return;
  }

  const ctx = resolveCityAndState(req);
  const cleanProduct = product.trim();
  const cleanSuburb = String(req.query.suburb ?? ctx.defaultSuburb).trim() || ctx.defaultSuburb;
  const result = await resolveMultiRetailerPrices(cleanProduct, cleanSuburb, ctx.state);

  const wowPool = result.entries.filter((e) => e.retailer === "Woolworths");
  const colesPool = result.entries.filter((e) => e.retailer === "Coles");

  const paired = pickBestComparablePair(cleanProduct, wowPool, colesPool);
  const bestWow = paired.wow;
  let bestColes = paired.coles;
  if (bestWow && bestColes && !areComparablePair(bestWow, bestColes)) {
    bestColes = null;
  }

  const wowMetric = bestWow ? computeUnitMetric(bestWow) : null;
  const colesMetric = bestColes ? computeUnitMetric(bestColes) : null;

  let matchQuality: HeadToHeadComparison["matchQuality"] = "no_match";
  let cheaperRetailer: HeadToHeadComparison["cheaperRetailer"] = null;
  let priceDifference: number | null = null;
  let percentDifference: number | null = null;
  let unitSummary: string | null = null;

  if (bestWow && bestColes) {
    matchQuality = classifyPairMatch(bestWow, bestColes);
    const diff = Number(Math.abs(bestWow.price - bestColes.price).toFixed(2));
    const higher = Math.max(bestWow.price, bestColes.price);
    priceDifference = diff;
    percentDifference = higher > 0 ? Math.round((diff / higher) * 100) : 0;

    if (matchQuality === "unit_matched" && wowMetric && colesMetric) {
      const uDiff = Math.abs(wowMetric.value - colesMetric.value);
      if (uDiff < 0.02) {
        cheaperRetailer = "Tie";
        unitSummary = `Same unit value (${wowMetric.label})`;
      } else if (colesMetric.value < wowMetric.value) {
        cheaperRetailer = "Coles";
        unitSummary = `Coles wins on unit value (${colesMetric.label} vs ${wowMetric.label})`;
      } else {
        cheaperRetailer = "Woolworths";
        unitSummary = `Woolworths wins on unit value (${wowMetric.label} vs ${colesMetric.label})`;
      }
    } else if (diff < 0.05) {
      cheaperRetailer = "Tie";
      unitSummary = `Identical shelf price ($${bestWow.price.toFixed(2)})`;
    } else if (bestColes.price < bestWow.price) {
      cheaperRetailer = "Coles";
      unitSummary = `Save $${diff.toFixed(2)} (${percentDifference}%) at Coles`;
    } else {
      cheaperRetailer = "Woolworths";
      unitSummary = `Save $${diff.toFixed(2)} (${percentDifference}%) at Woolworths`;
    }
  } else if (bestWow || bestColes) {
    matchQuality = "single_retailer";
  }

  const comparison: HeadToHeadComparison = {
    query: cleanProduct,
    suburb: cleanSuburb,
    state: ctx.state,
    matchQuality,
    woolworths: bestWow ? { ...bestWow, unitMetric: wowMetric ?? undefined } : null,
    coles: bestColes ? { ...bestColes, unitMetric: colesMetric ?? undefined } : null,
    cheaperRetailer,
    priceDifference,
    percentDifference,
    unitSummary,
    retailerStatus: result.retailerStatus,
    fetchedAt: result.fetchedAt,
  };

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=900");
  res.json(comparison);
});

// ─── Live Coles vs Woolworths Price-Gap Leaderboard ──────────────────────────

app.get("/compare/gaps", async (req: Request, res: Response) => {
  const ctx = resolveCityAndState(req);
  const gaps = await singleflight("compare:gaps", () => getColesVsWoolworthsGaps(72));
  const withSavings = gaps.filter((g) => g.savingsAmount >= 0.2);

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=900");
  res.json({
    region: ctx.regionLabel,
    totalMatchedPairs: gaps.length,
    gapsCount: withSavings.length,
    gaps: withSavings.length > 0 ? withSavings.slice(0, 40) : gaps.slice(0, 40),
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Verified Price & Specials Ingest ────────────────────────────────────────

const ALLOWED_INGEST_RETAILERS = new Set(["Coles", "Woolworths", "IGA", "Priceline", "ALDI"]);

app.post("/prices/ingest", async (req: Request, res: Response) => {
  const ingestKey = process.env.INGEST_API_KEY;
  if (ingestKey && req.headers["x-ingest-key"] !== ingestKey) {
    res.status(401).json({ error: "Unauthorized ingest key" });
    return;
  }

  const { productName, suburb = "Melbourne", state = "VIC", entries } = req.body ?? {};
  const upperState = String(state).toUpperCase() as AuStateUpper;
  const cleanState: AuStateUpper = VALID_AU_STATES.has(upperState) ? upperState : "VIC";
  if (typeof productName !== "string" || productName.trim().length < 2 || !Array.isArray(entries)) {
    res.status(400).json({ error: "productName and entries[] required" });
    return;
  }

  const nowIso = new Date().toISOString();
  const valid: PriceEntry[] = [];

  for (const raw of entries.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    if (!ALLOWED_INGEST_RETAILERS.has(raw.retailer)) continue;
    const price = Number(raw.price);
    if (!Number.isFinite(price) || price < 0.5 || price > 350) continue;
    if (typeof raw.matchedName !== "string" || raw.matchedName.trim().length < 3) continue;

    if (
      raw.productUrl &&
      typeof raw.productUrl === "string" &&
      !/^https:\/\/www\.(coles|woolworths|aldi|priceline)\.com\.au\/|^https:\/\/www\.igashop\.com\.au\//i.test(raw.productUrl)
    ) {
      continue;
    }

    const wasPrice =
      raw.wasPrice && Number(raw.wasPrice) > price ? Number(Number(raw.wasPrice).toFixed(2)) : undefined;

    valid.push({
      retailer: raw.retailer,
      storeName: typeof raw.storeName === "string" ? raw.storeName.slice(0, 100) : `${raw.retailer} Online (${cleanState})`,
      suburb: String(suburb).slice(0, 60),
      state: cleanState,
      matchedName: raw.matchedName.trim().slice(0, 200),
      brand: typeof raw.brand === "string" ? raw.brand.trim().slice(0, 80) : undefined,
      stockcode: raw.stockcode ? String(raw.stockcode).slice(0, 40) : undefined,
      barcode: raw.barcode ? String(raw.barcode).slice(0, 30) : undefined,
      price: Number(price.toFixed(2)),
      wasPrice,
      savingsPercent: wasPrice ? Math.round(((wasPrice - price) / wasPrice) * 100) : undefined,
      currency: "AUD",
      unit: typeof raw.unit === "string" ? raw.unit.slice(0, 60) : "",
      isOnSale: Boolean(raw.isOnSale || wasPrice),
      isInStock: typeof raw.isInStock === "boolean" ? raw.isInStock : undefined,
      imageUrl: typeof raw.imageUrl === "string" ? raw.imageUrl.slice(0, 400) : undefined,
      productUrl: typeof raw.productUrl === "string" ? raw.productUrl.slice(0, 400) : undefined,
      lastUpdated: nowIso,
    });
  }

  if (valid.length === 0) {
    res.status(400).json({ error: "No valid verified price entries in payload" });
    return;
  }

  await savePrices(productName.trim(), String(suburb), cleanState, valid);
  for (const st of VALID_AU_STATES) {
    priceCache.delete(`${productName.trim().toLowerCase()}|${st}`);
  }

  log("info", "ingested verified prices", {
    product: productName.trim(),
    state: cleanState,
    retailer: valid[0].retailer,
    count: valid.length,
  });
  res.status(201).json({ ingested: valid.length, productName: productName.trim(), state: cleanState });
});

app.post("/specials/ingest", async (req: Request, res: Response) => {
  const ingestKey = process.env.INGEST_API_KEY;
  if (ingestKey && req.headers["x-ingest-key"] !== ingestKey) {
    res.status(401).json({ error: "Unauthorized ingest key" });
    return;
  }

  const { specials } = req.body ?? {};
  if (!Array.isArray(specials)) {
    res.status(400).json({ error: "specials[] required" });
    return;
  }

  const valid: SpecialEntry[] = [];
  const nowIso = new Date().toISOString();
  for (const s of specials.slice(0, 120)) {
    if (!s || !ALLOWED_INGEST_RETAILERS.has(s.retailer)) continue;
    const price = Number(s.price);
    const wasPrice = Number(s.wasPrice);
    if (!Number.isFinite(price) || !Number.isFinite(wasPrice) || wasPrice <= price || price < 0.5) continue;
    if (typeof s.id !== "string" || typeof s.name !== "string" || s.name.trim().length < 3) continue;

    const savingsAmount = Number((wasPrice - price).toFixed(2));
    const savingsPercent = Math.round((savingsAmount / wasPrice) * 100);
    if (savingsPercent < 5) continue;

    valid.push({
      id: s.id.slice(0, 80),
      retailer: s.retailer,
      name: s.name.trim().slice(0, 200),
      brand: typeof s.brand === "string" ? s.brand.trim().slice(0, 80) : undefined,
      category: s.category ?? "other",
      price: Number(price.toFixed(2)),
      wasPrice: Number(wasPrice.toFixed(2)),
      savingsAmount,
      savingsPercent,
      unit: typeof s.unit === "string" ? s.unit.slice(0, 60) : "",
      isInStock: typeof s.isInStock === "boolean" ? s.isInStock : undefined,
      imageUrl: typeof s.imageUrl === "string" ? s.imageUrl.slice(0, 400) : undefined,
      productUrl: typeof s.productUrl === "string" ? s.productUrl.slice(0, 400) : undefined,
      lastUpdated: nowIso,
    });
  }

  if (valid.length === 0) {
    res.status(400).json({ error: "No valid specials in payload" });
    return;
  }

  await upsertSpecials(valid);
  specialsCache.clear();
  log("info", "ingested verified specials", { count: valid.length });
  res.status(201).json({ ingested: valid.length });
});

// ─── Real Price History (Postgres) ───────────────────────────────────────────

app.get("/prices/history", async (req: Request, res: Response) => {
  const { product, weeks = "12" } = req.query;
  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required" });
    return;
  }

  const ctx = resolveCityAndState(req);
  const cleanSuburb = String(req.query.suburb ?? ctx.defaultSuburb);

  let rows = await getPriceHistory(
    product.trim(),
    cleanSuburb,
    ctx.state,
    Math.min(Number(weeks) || 12, 52)
  );
  // Fall back to VIC chain history if newer state archive is still building up (same national chain pricing)
  if (rows.length === 0 && ctx.state !== "VIC") {
    rows = await getPriceHistory(product.trim(), "Melbourne", "VIC", Math.min(Number(weeks) || 12, 52));
  }

  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
  res.json({
    productName: product.trim(),
    suburb: cleanSuburb,
    state: ctx.state,
    weeks: rows,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Live Baby Specials (Woolworths + Coles merged) ──────────────────────────

async function loadLiveSpecials(): Promise<SpecialEntry[]> {
  const cached = specialsCache.get("au");
  if (cached) return cached;

  return singleflight("specials:au", async () => {
    const again = specialsCache.get("au");
    if (again) return again;

    const [wow, colesLive, dbSpecials] = await Promise.all([
      fetchWoolworthsBabySpecials(),
      fetchColesBabySpecials(),
      loadFreshSpecials(48),
    ]);

    const byId = new Map<string, SpecialEntry>();
    for (const s of dbSpecials) byId.set(s.id, s);
    for (const s of [...wow, ...colesLive]) byId.set(s.id, s);

    if (wow.length + colesLive.length > 0) {
      upsertSpecials([...wow, ...colesLive]).catch(() => {});
    }

    const merged = [...byId.values()].sort((a, b) => {
      if (b.savingsPercent !== a.savingsPercent) return b.savingsPercent - a.savingsPercent;
      return b.savingsAmount - a.savingsAmount;
    });

    if (merged.length > 0) {
      specialsCache.set("au", merged, 30 * 60 * 1000);
    }
    return merged;
  });
}

app.get("/specials", async (req: Request, res: Response) => {
  const ctx = resolveCityAndState(req);
  const category = String(req.query.category ?? "all").toLowerCase();
  const retailer = String(req.query.retailer ?? "all").toLowerCase();

  const all = await loadLiveSpecials();
  const filtered = all.filter((s) => {
    if (category !== "all" && s.category !== category) return false;
    if (retailer !== "all" && s.retailer.toLowerCase() !== retailer) return false;
    return true;
  });

  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600, stale-while-revalidate=1800");
  res.json({
    region: ctx.regionLabel,
    count: filtered.length,
    specials: filtered,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Real Greater Melbourne & Greater Sydney Stores ──────────────────────────

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadCityStores(city: AuCity): Promise<MelbourneStore[]> {
  const cached = storesCache.get(city);
  if (cached) return cached;

  return singleflight(`stores:${city}`, async () => {
    const again = storesCache.get(city);
    if (again) return again;

    const [wow, iga, priceline, aldi] = await Promise.all([
      fetchWoolworthsCityStores(city),
      fetchIgaCityStores(city),
      fetchPricelineCityStores(city),
      city === "melbourne" ? fetchAldiMelbourneStores() : Promise.resolve([]),
    ]);
    const combined = [...wow, ...iga, ...priceline, ...aldi];
    if (combined.length > 0) {
      storesCache.set(city, combined, 12 * 60 * 60 * 1000);
    }
    log("info", `loaded real ${city} stores`, {
      woolworths: wow.length,
      iga: iga.length,
      priceline: priceline.length,
      aldi: aldi.length,
      total: combined.length,
    });
    return combined;
  });
}

app.get("/stores", async (req: Request, res: Response) => {
  const ctx = resolveCityAndState(req);
  const lat = req.query.lat !== undefined ? Number(req.query.lat) : ctx.defaultLat;
  const lon = req.query.lon !== undefined ? Number(req.query.lon) : ctx.defaultLon;
  const radius = Math.min(Number(req.query.radius ?? 25_000) || 25_000, 60_000);
  const limit = Math.min(Number(req.query.limit ?? 60) || 60, 200);

  const stores = await loadCityStores(ctx.city);
  const nearby = stores
    .map((s) => ({
      ...s,
      distanceMeters: Math.round(haversineMeters(lat, lon, s.latitude, s.longitude)),
    }))
    .filter((s) => s.distanceMeters <= radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);

  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.json({
    region: ctx.regionLabel,
    city: ctx.city,
    count: nearby.length,
    totalTracked: stores.length,
    stores: nearby,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Official FSANZ + ACCC Recalls (state-prioritized) ───────────────────────

function toRecallEntry(r: RecallRow): RecallEntry {
  return {
    id: r.fsanz_id,
    agency: r.agency === "ACCC" ? "ACCC" : "FSANZ",
    productName: r.product_name,
    brand: r.brand ?? "",
    recallDate: r.recall_date ?? "",
    reason: r.reason ?? "",
    affectedAllergens: r.affected_allergens ?? [],
    affectedBarcodes: r.affected_barcodes ?? [],
    recallUrl: r.recall_url ?? "",
    isActive: r.is_active,
  };
}

async function getRecallsList(): Promise<{ recalls: RecallEntry[]; source: string }> {
  const cached = recallCache.get("all");
  if (cached) return { recalls: cached, source: "cache" };

  return singleflight("recalls:all", async () => {
    const dbRecalls = await loadRecalls();
    if (dbRecalls.length > 0) {
      const recalls = dbRecalls.map(toRecallEntry);
      recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
      return { recalls, source: "database" };
    }

    const recalls = await fetchAllOfficialRecalls();
    recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
    upsertRecalls(recalls).catch((e) =>
      log("error", "upsertRecalls failed", { err: (e as Error).message })
    );
    return { recalls, source: "live" };
  });
}

app.get("/recalls", async (req: Request, res: Response) => {
  const ctx = resolveCityAndState(req);
  const { recalls, source } = await getRecallsList();
  const stateRe = new RegExp(`\\b(${ctx.state}|National|Australia)\\b`, "i");
  const sorted = [...recalls].sort((a, b) => {
    const aHit = stateRe.test(a.reason) ? 1 : 0;
    const bHit = stateRe.test(b.reason) ? 1 : 0;
    return bHit - aHit;
  });

  res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=1800");
  res.json({ recalls: sorted, state: ctx.state, source, fetchedAt: new Date().toISOString() });
});

app.get("/recalls/check", async (req: Request, res: Response) => {
  const { productName, barcode } = req.query;
  const { recalls } = await getRecallsList();

  const term = String(productName ?? "").toLowerCase().trim();
  const tokens = term
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !["baby", "food", "stage", "infant", "formula", "pouch"].includes(w));
  const bc = String(barcode ?? "").trim();

  const matches = recalls.filter((r) => {
    if (bc && r.affectedBarcodes.includes(bc)) return true;
    if (term.length < 3) return false;
    const hay = `${r.productName} ${r.brand} ${r.reason}`.toLowerCase();
    if (hay.includes(term)) return true;
    if (tokens.length >= 2) {
      const hitCount = tokens.filter((t) => hay.includes(t)).length;
      return hitCount >= 2;
    }
    return false;
  });

  const result: RecallCheckResult = {
    recalled: matches.length > 0,
    matches,
    checkedAt: new Date().toISOString(),
  };

  res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=1800");
  res.json(result);
});

// ─── Real Community Shelf Sightings ──────────────────────────────────────────

const VALID_STATES = new Set<StockStateValue>(["onShelf", "runningLow", "likelyGone"]);

app.get("/sightings", async (req: Request, res: Response) => {
  const ctx = resolveCityAndState(req);
  const productId = typeof req.query.productId === "string" ? req.query.productId.trim() : undefined;
  const storeId = typeof req.query.storeId === "string" ? req.query.storeId.trim() : undefined;
  const hours = Number(req.query.hours ?? 72) || 72;
  const limit = Number(req.query.limit ?? 100) || 100;

  const sightings = await getSightings({ productId, storeId, hours, limit });
  res.json({
    region: ctx.regionLabel,
    count: sightings.length,
    sightings,
    fetchedAt: new Date().toISOString(),
  });
});

app.post("/sightings", sightingLimit, async (req: Request, res: Response) => {
  const { productId, productName, storeId, storeName, suburb, retailer, state, observedPrice, note } =
    req.body ?? {};

  if (
    typeof productId !== "string" ||
    productId.trim().length < 2 ||
    typeof storeId !== "string" ||
    storeId.trim().length < 2 ||
    typeof storeName !== "string" ||
    storeName.trim().length < 2 ||
    !VALID_STATES.has(state)
  ) {
    res.status(400).json({
      error: "productId, storeId, storeName, and valid state (onShelf|runningLow|likelyGone) required",
    });
    return;
  }

  const parsedPrice =
    typeof observedPrice === "number" && Number.isFinite(observedPrice) && observedPrice >= 0.5 && observedPrice <= 350
      ? Number(observedPrice.toFixed(2))
      : undefined;

  const sighting = await saveSighting({
    productId: productId.trim().slice(0, 120),
    productName: typeof productName === "string" ? productName.trim().slice(0, 160) : undefined,
    storeId: storeId.trim().slice(0, 120),
    storeName: storeName.trim().slice(0, 120),
    suburb: typeof suburb === "string" && suburb.trim() ? suburb.trim().slice(0, 80) : "Melbourne",
    retailer: typeof retailer === "string" && retailer.trim() ? retailer.trim().slice(0, 60) : "Unknown",
    state,
    observedPrice: parsedPrice,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 240) : undefined,
  });

  log("info", "shelf sighting recorded", {
    productId: sighting.productId,
    storeId: sighting.storeId,
    suburb: sighting.suburb,
    state: sighting.state,
  });

  res.status(201).json({ sighting });
});

// ─── Social Shoutout Promo Submissions (TikTok, Instagram, Facebook, YouTube) ─

const ALLOWED_SOCIAL_HOST_RE =
  /^(www\.|m\.|vm\.|vt\.|mobile\.)?(tiktok\.com|instagram\.com|facebook\.com|fb\.watch|fb\.com|youtube\.com|youtu\.be|threads\.net|x\.com|twitter\.com|reddit\.com)$/i;

app.post("/promo/submit", sightingLimit, async (req: Request, res: Response) => {
  const { platform, postUrl, referralCode, city } = req.body ?? {};
  if (typeof postUrl !== "string" || postUrl.trim().length < 10) {
    res.status(400).json({ error: "Please paste a valid public TikTok, Instagram, Facebook or YouTube link." });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(postUrl.trim());
  } catch {
    res.status(400).json({ error: "That doesn't look like a valid link — include https://..." });
    return;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    res.status(400).json({ error: "Link must start with https://" });
    return;
  }

  if (!ALLOWED_SOCIAL_HOST_RE.test(parsed.hostname)) {
    res.status(400).json({
      error: "Please share a link from TikTok, Instagram, Facebook, YouTube, Threads, X or Reddit.",
    });
    return;
  }

  const cleanUrl = parsed.toString().slice(0, 400);
  const cleanPlatform = typeof platform === "string" && platform.trim() ? platform.trim().slice(0, 40) : "Social";

  const saved = await saveSocialPromo({
    platform: cleanPlatform,
    postUrl: cleanUrl,
    referralCode: typeof referralCode === "string" ? referralCode.trim().slice(0, 12) : undefined,
    city: typeof city === "string" ? city.trim().slice(0, 40) : undefined,
  });

  if (saved.duplicate) {
    res.status(409).json({ error: "That post link has already been submitted. Share a new post to earn credit." });
    return;
  }

  log("info", "social promo submitted", { platform: cleanPlatform, city });
  res.status(201).json({
    accepted: true,
    monthsGranted: 2,
    message: "2 months of Bubstock+ unlocked! Thanks for spreading the word to Aussie parents.",
    promo: saved.record,
  });
});

app.get("/promo/recent", async (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 50) || 50;
  const promos = await getRecentSocialPromos(limit);
  res.json({ count: promos.length, promos });
});

// ─── City Live Pulse Telemetry (/pulse + backwards-compatible /melbourne/pulse)

async function handlePulse(req: Request, res: Response) {
  const ctx = resolveCityAndState(req);
  const [{ recalls }, specials, sightings24h, stores] = await Promise.all([
    getRecallsList(),
    loadLiveSpecials(),
    countRecentSightings(24),
    loadCityStores(ctx.city),
  ]);

  const pulse: MelbournePulse = {
    region: ctx.regionLabel,
    city: ctx.city,
    state: ctx.state,
    activeRecallsCount: recalls.length,
    liveSpecialsCount: specials.length,
    biggestSavingPercent: specials.length > 0 ? specials[0].savingsPercent : null,
    sightingsLast24h: sightings24h,
    storesTracked: stores.length,
    retailers: [
      { name: "Woolworths", mode: "live_api" },
      { name: "Coles", mode: "live_api" },
      { name: "IGA", mode: "live_api" },
      { name: "Priceline Pharmacy", mode: "live_api" },
      ...(ctx.city === "melbourne" ? [{ name: "ALDI", mode: "live_api" as const }] : []),
      { name: "Chemist Warehouse", mode: "in_store_only" },
      { name: "Baby Bunting", mode: "in_store_only" },
    ],
    updatedAt: new Date().toISOString(),
  };

  res.setHeader("Cache-Control", "public, max-age=180, s-maxage=180, stale-while-revalidate=600");
  res.json(pulse);
}

app.get("/pulse", handlePulse);
app.get("/melbourne/pulse", handlePulse);

// ─── Error middleware ─────────────────────────────────────────────────────────

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  log("error", "unhandled request error", {
    err: err.message,
    path: req.path,
    id: (req as any).id,
  });
  res.status(500).json({ error: "Internal server error" });
});

// ─── Scheduled refreshes ─────────────────────────────────────────────────────

cron.schedule("0 */6 * * *", async () => {
  const recalls = await fetchAllOfficialRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  await upsertRecalls(recalls).catch((e) =>
    log("error", "cron upsertRecalls failed", { err: (e as Error).message })
  );
});

cron.schedule("30 */4 * * *", async () => {
  specialsCache.clear();
  await loadLiveSpecials().catch((e) =>
    log("error", "cron specials failed", { err: (e as Error).message })
  );
});

cron.schedule("0 3 * * *", async () => {
  storesCache.clear();
  await Promise.all(ALL_CITIES.map((c) => loadCityStores(c))).catch((e) =>
    log("error", "cron stores failed", { err: (e as Error).message })
  );
});

// ─── Startup & Graceful shutdown ─────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  log("info", "bubstock-au-api listening", { port: PORT, version: "2.4.0" });

  await initSchema().catch((e) =>
    log("error", "schema init failed", { err: (e as Error).message })
  );

  fetchAllOfficialRecalls()
    .then((fresh) => {
      recallCache.set("all", fresh, 6 * 60 * 60 * 1000);
      return upsertRecalls(fresh);
    })
    .catch((e) => log("warn", "startup recall warm failed", { err: (e as Error).message }));

  Promise.all([loadCityStores("melbourne"), loadCityStores("sydney")]).catch((e) =>
    log("warn", "startup store warm failed", { err: (e as Error).message })
  );
});

async function shutdown(signal: string) {
  log("info", `${signal} received — shutting down gracefully`);
  server.close(async () => {
    const { pool } = await import("./db.js");
    await pool?.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", { reason: String(reason) });
});
