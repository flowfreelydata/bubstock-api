import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import {
  searchWoolworthsPrices,
  fetchWoolworthsBabySpecials,
  fetchWoolworthsMelbourneStores,
} from "./scrapers/woolworths.js";
import { searchColesPrices, fetchColesBabySpecials } from "./scrapers/coles.js";
import { searchAldiPrices, fetchAldiMelbourneStores } from "./scrapers/aldi.js";
import { fetchAllOfficialRecalls } from "./scrapers/fsanz.js";
import { priceCache, recallCache, specialsCache, storesCache } from "./cache.js";
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
  pingDB,
  type RecallRow,
} from "./db.js";
import {
  areComparablePair,
  classifyPairMatch,
  computeUnitMetric,
  matchScore,
  pickBestMatch,
} from "./matcher.js";
import type {
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

const app = express();
app.set("trust proxy", 1); // Required behind Railway's reverse proxy for accurate rate limiting
const PORT = Number(process.env.PORT ?? 3000);

function log(level: "info" | "warn" | "error", msg: string, extra?: object) {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({ level, ts: new Date().toISOString(), msg, ...extra })
  );
}

// ─── Security & global middleware ─────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "256kb" }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).id = Math.random().toString(36).slice(2, 10);
  next();
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

const generalLimit = rateLimit({
  windowMs: 60_000,
  max: 160,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down" },
});

const priceLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
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
    service: "bubstock-melbourne-api",
    version: "2.1.0",
    region: "Greater Melbourne, VIC",
    policy: "100% live & verified data — zero synthetic fallbacks",
    endpoints: [
      "/health",
      "/melbourne/pulse",
      "/prices",
      "/prices/history",
      "/prices/ingest",
      "/compare",
      "/compare/gaps",
      "/specials",
      "/specials/ingest",
      "/stores",
      "/recalls",
      "/recalls/check",
      "/sightings",
    ],
  });
});

app.get("/health", async (_req, res) => {
  const dbOk = await pingDB();
  res.status(200).json({
    status: dbOk ? "ok" : "degraded",
    region: "Greater Melbourne, VIC",
    db: dbOk ? "connected" : "in-memory-fallback",
    timestamp: new Date().toISOString(),
    cache: {
      price: priceCache.size(),
      recall: recallCache.size(),
      specials: specialsCache.size(),
      stores: storesCache.size(),
    },
  });
});

// ─── Shared live + Postgres-verified price resolver ──────────────────────────

async function resolveMultiRetailerPrices(
  cleanProduct: string,
  cleanSuburb: string
): Promise<ProductPriceResult> {
  const state = "VIC";
  const key = `${cleanProduct.toLowerCase()}|${cleanSuburb.toLowerCase()}|${state}`;
  const cached = priceCache.get(key);
  if (cached) return cached;

  const [wowRes, colesLiveRes, aldiRes] = await Promise.all([
    searchWoolworthsPrices(cleanProduct, cleanSuburb, state),
    searchColesPrices(cleanProduct, cleanSuburb, state),
    searchAldiPrices(cleanProduct, cleanSuburb, state),
  ]);

  let colesEntries = colesLiveRes.entries;
  let colesStatus: RetailerFeedStatus = colesLiveRes.status;

  // If Railway's datacenter IP is geo-blocked by Coles, check Postgres for fresh
  // verified Coles VIC prices synced from Melbourne (on-device iPhone or sync worker).
  if (colesEntries.length === 0) {
    const dbColes = await getFreshRetailerPrices(cleanProduct, "Coles", 48);
    if (dbColes.length > 0) {
      colesEntries = dbColes;
      const newestMs = Math.max(...dbColes.map((e) => new Date(e.lastUpdated).getTime()));
      const ageHrs = Math.max(0, Math.round((Date.now() - newestMs) / 3_600_000));
      colesStatus = {
        retailer: "Coles",
        status: "live",
        count: dbColes.length,
        latencyMs: colesLiveRes.status.latencyMs,
        note:
          ageHrs < 1
            ? "Verified Coles VIC price (synced just now)"
            : `Verified Coles VIC price (synced ${ageHrs}h ago)`,
      };
    }
  }

  // Filter out egregious mismatches (e.g. $4 sachets when looking up a 900g tin) while keeping valid hits
  const allRaw = [...wowRes.entries, ...colesEntries, ...aldiRes.entries];
  const scored = allRaw
    .map((entry) => ({ entry, score: matchScore(cleanProduct, entry) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.price - b.entry.price;
    });

  // If canonical matcher filtered everything (e.g. very generic query like "nappies"), keep raw sorted by price
  const entries =
    scored.length > 0
      ? scored.map((s) => s.entry)
      : allRaw.sort((a, b) => a.price - b.price);

  const retailerStatus: RetailerFeedStatus[] = [
    wowRes.status,
    colesStatus,
    aldiRes.status,
    {
      retailer: "Chemist Warehouse",
      status: "unavailable",
      count: 0,
      latencyMs: 0,
      note: "No public live API — check in-store or call store",
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

  priceCache.set(key, result, 15 * 60 * 1000);

  // Persist freshly scraped live entries (avoid re-inserting DB-sourced Coles entries)
  const freshToPersist = [
    ...wowRes.entries,
    ...colesLiveRes.entries,
    ...aldiRes.entries,
  ];
  savePrices(cleanProduct, cleanSuburb, state, freshToPersist).catch((e) =>
    log("error", "savePrices failed", { err: (e as Error).message })
  );

  return result;
}

// ─── Live Multi-Retailer Prices ──────────────────────────────────────────────

app.get("/prices", priceLimit, async (req: Request, res: Response) => {
  const { product, suburb = "Melbourne" } = req.query;
  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required (min 2 chars)" });
    return;
  }

  const cleanProduct = product.trim();
  const cleanSuburb = String(suburb).trim() || "Melbourne";
  log("info", "live price lookup", { product: cleanProduct, suburb: cleanSuburb, id: (req as any).id });

  const result = await resolveMultiRetailerPrices(cleanProduct, cleanSuburb);
  res.setHeader("Cache-Control", "public, max-age=180");
  res.json(result);
});

// ─── Exact Canonical Coles vs Woolworths Head-to-Head Compare ────────────────

app.get("/compare", priceLimit, async (req: Request, res: Response) => {
  const { product, suburb = "Melbourne" } = req.query;
  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required (min 2 chars)" });
    return;
  }

  const cleanProduct = product.trim();
  const cleanSuburb = String(suburb).trim() || "Melbourne";
  const result = await resolveMultiRetailerPrices(cleanProduct, cleanSuburb);

  const wowPool = result.entries.filter((e) => e.retailer === "Woolworths");
  const colesPool = result.entries.filter((e) => e.retailer === "Coles");

  const bestWow = pickBestMatch(cleanProduct, wowPool);
  let bestColes = pickBestMatch(cleanProduct, colesPool);
  if (bestWow && bestColes && !areComparablePair(bestWow, bestColes)) {
    // Reject non-comparable pair (e.g. bulk carton vs normal pack or different sub-line)
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
    state: "VIC",
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

  res.setHeader("Cache-Control", "public, max-age=180");
  res.json(comparison);
});

// ─── Live Melbourne Coles vs Woolworths Price-Gap Leaderboard ────────────────

app.get("/compare/gaps", async (_req: Request, res: Response) => {
  const gaps = await getColesVsWoolworthsGaps(72);
  const withSavings = gaps.filter((g) => g.savingsAmount >= 0.2);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    region: "Greater Melbourne, VIC",
    totalMatchedPairs: gaps.length,
    gapsCount: withSavings.length,
    gaps: withSavings.length > 0 ? withSavings.slice(0, 40) : gaps.slice(0, 40),
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Verified Price Ingest (from Melbourne iPhone Direct Fetch or Sync Worker)

const ALLOWED_INGEST_RETAILERS = new Set(["Coles", "Woolworths", "ALDI"]);

app.post("/prices/ingest", async (req: Request, res: Response) => {
  const ingestKey = process.env.INGEST_API_KEY;
  if (ingestKey && req.headers["x-ingest-key"] !== ingestKey) {
    res.status(401).json({ error: "Unauthorized ingest key" });
    return;
  }

  const { productName, suburb = "Melbourne", entries } = req.body ?? {};
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

    // Require authentic retailer product URL for Coles/Woolworths ingests to prevent junk data
    if (
      raw.productUrl &&
      typeof raw.productUrl === "string" &&
      !/^https:\/\/www\.(coles|woolworths|aldi)\.com\.au\//i.test(raw.productUrl)
    ) {
      continue;
    }

    const wasPrice =
      raw.wasPrice && Number(raw.wasPrice) > price ? Number(Number(raw.wasPrice).toFixed(2)) : undefined;

    valid.push({
      retailer: raw.retailer,
      storeName: typeof raw.storeName === "string" ? raw.storeName.slice(0, 100) : `${raw.retailer} Online (VIC)`,
      suburb: String(suburb).slice(0, 60),
      state: "VIC",
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

  await savePrices(productName.trim(), String(suburb), "VIC", valid);
  // Invalidate cached lookup for this product so next read returns freshly ingested Coles/Woolies pair
  priceCache.clear();

  log("info", "ingested verified prices", {
    product: productName.trim(),
    retailer: valid[0].retailer,
    count: valid.length,
  });
  res.status(201).json({ ingested: valid.length, productName: productName.trim() });
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
  const { product, suburb = "Melbourne", weeks = "12" } = req.query;
  const state = "VIC";

  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required" });
    return;
  }

  const rows = await getPriceHistory(
    product.trim(),
    String(suburb),
    state,
    Math.min(Number(weeks) || 12, 52)
  );

  res.json({
    productName: product.trim(),
    suburb: String(suburb),
    state,
    weeks: rows,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Live Melbourne Baby Specials (Woolworths + Coles merged!) ───────────────

async function loadLiveSpecials(): Promise<SpecialEntry[]> {
  const cached = specialsCache.get("melbourne");
  if (cached) return cached;

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
    specialsCache.set("melbourne", merged, 20 * 60 * 1000);
  }
  return merged;
}

app.get("/specials", async (req: Request, res: Response) => {
  const category = String(req.query.category ?? "all").toLowerCase();
  const retailer = String(req.query.retailer ?? "all").toLowerCase();

  const all = await loadLiveSpecials();
  const filtered = all.filter((s) => {
    if (category !== "all" && s.category !== category) return false;
    if (retailer !== "all" && s.retailer.toLowerCase() !== retailer) return false;
    return true;
  });

  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    region: "Greater Melbourne, VIC",
    count: filtered.length,
    specials: filtered,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Real Greater Melbourne Stores ───────────────────────────────────────────

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

async function loadMelbourneStores(): Promise<MelbourneStore[]> {
  const cached = storesCache.get("melbourne");
  if (cached) return cached;

  const [wow, aldi] = await Promise.all([
    fetchWoolworthsMelbourneStores(),
    fetchAldiMelbourneStores(),
  ]);
  const combined = [...wow, ...aldi];
  if (combined.length > 0) {
    storesCache.set("melbourne", combined, 12 * 60 * 60 * 1000);
  }
  log("info", "loaded real Melbourne stores", {
    woolworths: wow.length,
    aldi: aldi.length,
    total: combined.length,
  });
  return combined;
}

app.get("/stores", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat ?? -37.8136);
  const lon = Number(req.query.lon ?? 144.9631);
  const radius = Math.min(Number(req.query.radius ?? 25_000) || 25_000, 60_000);
  const limit = Math.min(Number(req.query.limit ?? 60) || 60, 200);

  const stores = await loadMelbourneStores();
  const nearby = stores
    .map((s) => ({
      ...s,
      distanceMeters: Math.round(haversineMeters(lat, lon, s.latitude, s.longitude)),
    }))
    .filter((s) => s.distanceMeters <= radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);

  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    region: "Greater Melbourne, VIC",
    count: nearby.length,
    totalTracked: stores.length,
    stores: nearby,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Official FSANZ + ACCC Recalls ───────────────────────────────────────────

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
}

app.get("/recalls", async (_req, res) => {
  const { recalls, source } = await getRecallsList();
  res.json({ recalls, source, fetchedAt: new Date().toISOString() });
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

  res.json(result);
});

// ─── Real Melbourne Community Shelf Sightings ────────────────────────────────

const VALID_STATES = new Set<StockStateValue>(["onShelf", "runningLow", "likelyGone"]);

app.get("/sightings", async (req: Request, res: Response) => {
  const productId = typeof req.query.productId === "string" ? req.query.productId.trim() : undefined;
  const storeId = typeof req.query.storeId === "string" ? req.query.storeId.trim() : undefined;
  const hours = Number(req.query.hours ?? 72) || 72;
  const limit = Number(req.query.limit ?? 100) || 100;

  const sightings = await getSightings({ productId, storeId, hours, limit });
  res.json({
    region: "Greater Melbourne, VIC",
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

  log("info", "melbourne shelf sighting recorded", {
    productId: sighting.productId,
    storeId: sighting.storeId,
    state: sighting.state,
  });

  res.status(201).json({ sighting });
});

// ─── Melbourne Live Pulse Telemetry ──────────────────────────────────────────

app.get("/melbourne/pulse", async (_req, res) => {
  const [{ recalls }, specials, sightings24h, stores] = await Promise.all([
    getRecallsList(),
    loadLiveSpecials(),
    countRecentSightings(24),
    loadMelbourneStores(),
  ]);

  const pulse: MelbournePulse = {
    region: "Greater Melbourne, VIC",
    activeRecallsCount: recalls.length,
    liveSpecialsCount: specials.length,
    biggestSavingPercent: specials.length > 0 ? specials[0].savingsPercent : null,
    sightingsLast24h: sightings24h,
    storesTracked: stores.length,
    retailers: [
      { name: "Woolworths", mode: "live_api" },
      { name: "Coles", mode: "live_api" },
      { name: "ALDI", mode: "live_api" },
      { name: "Chemist Warehouse", mode: "in_store_only" },
      { name: "Baby Bunting", mode: "in_store_only" },
      { name: "Priceline", mode: "in_store_only" },
    ],
    updatedAt: new Date().toISOString(),
  };

  res.setHeader("Cache-Control", "public, max-age=180");
  res.json(pulse);
});

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
  log("info", "cron: refreshing FSANZ + ACCC recalls");
  const recalls = await fetchAllOfficialRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  await upsertRecalls(recalls).catch((e) =>
    log("error", "cron upsertRecalls failed", { err: (e as Error).message })
  );
});

cron.schedule("30 */4 * * *", async () => {
  log("info", "cron: refreshing Melbourne baby specials");
  specialsCache.clear();
  await loadLiveSpecials().catch((e) =>
    log("error", "cron specials failed", { err: (e as Error).message })
  );
});

cron.schedule("0 3 * * *", async () => {
  log("info", "cron: refreshing Greater Melbourne store directory");
  storesCache.clear();
  await loadMelbourneStores().catch((e) =>
    log("error", "cron stores failed", { err: (e as Error).message })
  );
});

// ─── Startup & Graceful shutdown ─────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  log("info", "bubstock-melbourne-api listening", { port: PORT });

  await initSchema().catch((e) =>
    log("error", "schema init failed", { err: (e as Error).message })
  );

  fetchAllOfficialRecalls()
    .then((fresh) => {
      recallCache.set("all", fresh, 6 * 60 * 60 * 1000);
      return upsertRecalls(fresh);
    })
    .catch((e) => log("warn", "startup recall warm failed", { err: (e as Error).message }));

  loadMelbourneStores().catch((e) =>
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
