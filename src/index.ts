import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import crypto from "node:crypto";
import zlib from "node:zlib";
import {
  searchWoolworthsPrices,
  fetchWoolworthsBabySpecials,
  fetchWoolworthsCityStores,
} from "./scrapers/woolworths.js";
import { searchColesPrices, fetchColesBabySpecials } from "./scrapers/coles.js";
import {
  searchAldiPrices,
  findAldiMamiaEquivalent,
  fetchAldiCityStores,
} from "./scrapers/aldi.js";
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
  getMedianProductPrice,
  saveSighting,
  getSightings,
  countRecentSightings,
  saveSocialPromo,
  getRecentSocialPromos,
  upsertPushSubscription,
  getPushSubscription,
  listActiveApnsSubscriptions,
  markPushAlertSentIfNew,
  clearInvalidApnsToken,
  upsertHouseholdVault,
  getHouseholdVault,
  registerReferralCode,
  redeemReferralCode,
  getReferralCodeOwnerStatus,
  hasDeviceVerifiedPromoOrReferral,
  createMothersGroup,
  joinMothersGroup,
  getMothersGroup,
  getSuburbShortages,
  detectShrinkflation,
  getCategoryMedians,
  isDeviceShadowBanned,
  recordDeviceStrike,
  countRecentLikelyGoneByDevice,
  getSecurityTelemetrySummary,
  pruneStaleRecords,
  pingDB,
  type PushSubscriptionRecord,
  type RecallRow,
  type WatchedAlertRule,
} from "./db.js";
import {
  enrollHardwareKey,
  issueAttestChallenge,
  securityContextMiddleware,
  verifyStoreKitJwsCrypto,
} from "./security.js";
import {
  applyProgressiveTarpit,
  buildSyntheticMirageComparison,
  buildSyntheticMiragePrices,
  clearHostileIp,
  hashIp,
  mountHoneypotRoutes,
  transformToGhostComparison,
  transformToGhostGaps,
  transformToGhostHistory,
  transformToGhostPrices,
  transformToGhostSpecials,
  warmHostileCache,
} from "./deception.js";
import {
  SEO_FLAGSHIP_SLUGS,
  renderCostIndexPage,
  renderHalfPriceDealsPage,
  renderProductCityPricePage,
  renderSitemapXml,
  type BabyCostIndexData,
} from "./seo.js";
import { isApnsConfigured, sendApnsPush } from "./push.js";
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
app.disable("x-powered-by");
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT ?? 3000);

function sanitizeText(input: unknown, maxLen: number): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/[\u0000-\u001F\u007F<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function timingSafeKeyMatch(provided: unknown, expected: string | undefined): boolean {
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function log(level: "info" | "warn" | "error", msg: string, extra?: object) {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({ level, ts: new Date().toISOString(), msg, ...extra })
  );
}

// ─── Security, strict CORS, anti-leech guard & gzip compression ──────────────

const ALLOWED_BROWSER_ORIGINS = new Set([
  "https://bubstock-api-production.up.railway.app",
  "https://bubstock.com.au",
  "https://www.bubstock.com.au",
]);

const ALLOWED_IMAGE_URL_RE =
  /^https:\/\/([a-z0-9-]+\.)?(woolworths\.com\.au|woolworths\.media|coles\.com\.au|igashop\.com\.au|priceline\.com\.au|aldi\.com\.au|aldi\.cx|chemistwarehouse\.com\.au|babybunting\.com\.au)\//i;

const SEO_FLAGSHIP_SLUG_SET = new Set(SEO_FLAGSHIP_SLUGS);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: (origin, callback) => {
      // Native iOS URLSession, Widgets & Siri requests send no browser Origin header
      if (!origin || ALLOWED_BROWSER_ORIGINS.has(origin.toLowerCase())) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "POST"],
  })
);
app.use(
  express.json({
    limit: "256kb",
    verify: (req, _res, buf) => {
      (req as Request).rawBody = buf;
    },
  })
);

// Apple SEAR Hardware Attestation + Project Zero Threat Classifier
app.use(securityContextMiddleware);

// Block untrusted cross-origin browser requests; let automated scrapers & hostile fingerprints
// on read-only price routes fall silently into the Ghost Price Mirage + Canary + Tarpit trap.
function antiLeechGuard(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const origin = String(req.headers["origin"] ?? "");
  if (origin && !ALLOWED_BROWSER_ORIGINS.has(origin.toLowerCase())) {
    res.status(403).json({ error: "Cross-origin API access is not permitted" });
    return;
  }
  next();
}

// Strict guard for write/private endpoints (vaults, referrals, syndicates)
function strictBotGuard(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const origin = String(req.headers["origin"] ?? "");
  if (origin && !ALLOWED_BROWSER_ORIGINS.has(origin.toLowerCase())) {
    res.status(403).json({ error: "Cross-origin API access is not permitted" });
    return;
  }
  if (req.security?.isScraperUa) {
    res.status(403).json({ error: "Automated bot access is not permitted" });
    return;
  }
  next();
}

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

const ingestLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Ingest rate limit exceeded — slow down" },
});

const dataDumpLimit = rateLimit({
  windowMs: 60_000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many data requests — please slow down" },
});

const vaultWriteLimit = rateLimit({
  windowMs: 5 * 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Household sync write limit exceeded — try again in a few minutes" },
});

const vaultReadLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many household sync reads — slow down" },
});

app.use(generalLimit);

// ─── Root & Health ────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    service: "bubstock-au-api",
    version: "3.2.0",
    apnsReady: isApnsConfigured(),
    cities: Object.values(CITY_CONTEXTS).map((c) => c.regionLabel),
    policy: "100% live & verified data — zero synthetic fallbacks",
    endpoints: [
      "/health",
      "/attest/challenge",
      "/attest/enroll",
      "/entitlements/verify",
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
      "/shortages",
      "/shrinkflation",
      "/index/au",
      "/household/sync",
      "/groups/create",
      "/groups/join",
      "/au/half-price-baby-deals",
      "/au/prices/:city/:slug",
      "/au/index",
      "/sitemap.xml",
    ],
  });
});

// ─── Project Zero Honeypot Tripwires (Never Called by Legitimate App) ────────
mountHoneypotRoutes(app);

// ─── Apple SEAR Hardware Attestation & Zero-Trust Entitlement Verification ───

app.get("/attest/challenge", strictBotGuard, sightingLimit, (req: Request, res: Response) => {
  const ipHash = req.security?.ipHash ?? hashIp(req.ip);
  const issued = issueAttestChallenge(ipHash);
  res.setHeader("Cache-Control", "no-store, private");
  res.json(issued);
});

app.post("/attest/enroll", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const ipHash = req.security?.ipHash ?? hashIp(req.ip);
  const result = await enrollHardwareKey({
    keyId: req.body?.keyId,
    publicKeyB64: req.body?.publicKeyB64,
    challenge: req.body?.challenge,
    challengeSignatureB64: req.body?.challengeSignatureB64,
    attestMode: req.body?.attestMode,
    appAttestObjectB64: req.body?.appAttestObjectB64,
    bundleId: req.body?.bundleId,
    ipHash,
  });
  res.setHeader("Cache-Control", "no-store, private");
  if (!result.ok) {
    res.status(result.status).json({ enrolled: false, error: result.error });
    return;
  }
  res.status(result.status).json({ enrolled: true, mode: result.mode });
});

app.post("/entitlements/verify", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const storekitJws = req.body?.storekitJws ?? req.headers["x-bubstock-receipt"];
  const cleanDeviceId = sanitizeText(req.body?.deviceId, 80);

  const cryptoResult = verifyStoreKitJwsCrypto(storekitJws);
  const previewActive =
    !cryptoResult.valid && cleanDeviceId.length >= 8
      ? await hasDeviceVerifiedPromoOrReferral(cleanDeviceId)
      : false;

  res.setHeader("Cache-Control", "no-store, private");
  res.json({
    paidSubscriber: cryptoResult.valid,
    previewActive,
    hasPlus: cryptoResult.valid || previewActive,
    verifiedBy: cryptoResult.valid
      ? "apple_es256_jws"
      : previewActive
        ? "postgres_preview"
        : "none",
    productId: cryptoResult.productId ?? null,
    checkedAt: new Date().toISOString(),
  });
});

app.get("/admin/security/summary", async (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_API_KEY ?? process.env.INGEST_API_KEY;
  if (!adminKey || !timingSafeKeyMatch(req.headers["x-admin-key"], adminKey)) {
    res.status(403).json({ error: "Forbidden — admin key required" });
    return;
  }
  const summary = await getSecurityTelemetrySummary();
  res.setHeader("Cache-Control", "no-store, private");
  res.json({
    service: "bubstock-au-api",
    version: "3.2.0",
    ...summary,
    generatedAt: new Date().toISOString(),
  });
});

app.post("/admin/security/unblock-ip", async (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_API_KEY ?? process.env.INGEST_API_KEY;
  if (!adminKey || !timingSafeKeyMatch(req.headers["x-admin-key"], adminKey)) {
    res.status(403).json({ error: "Forbidden — admin key required" });
    return;
  }
  const targetIp = typeof req.body?.ip === "string" && req.body.ip.trim() ? req.body.ip.trim() : req.ip;
  const ipHash = hashIp(targetIp);
  clearHostileIp(ipHash);
  const { pool } = await import("./db.js");
  await pool?.query(`DELETE FROM hostile_fingerprints WHERE ip_hash = $1`, [ipHash]).catch(() => {});
  res.json({ unblocked: true, ipHash });
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

    // Query all 5 open live Australian retail APIs in parallel + ALDI Mamia equivalent matcher
    // (ALDI operates across all 5 mainland states: VIC, NSW, QLD, WA, SA — not TAS)
    const includeAldi = state !== "TAS";

    const [wowRes, colesLiveRes, igaRes, pricelineRes, aldiRes, aldiEquivalent] = await Promise.all([
      searchWoolworthsPrices(cleanProduct, cleanSuburb, state),
      searchColesPrices(cleanProduct, cleanSuburb, state),
      searchIgaPrices(cleanProduct, cleanSuburb, state),
      searchPricelinePrices(cleanProduct, cleanSuburb, state),
      searchAldiPrices(cleanProduct, cleanSuburb, state),
      includeAldi
        ? findAldiMamiaEquivalent(cleanProduct, cleanSuburb, state)
        : Promise.resolve(undefined),
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

    const aldiFinalStatus: RetailerFeedStatus =
      aldiRes.entries.length === 0 && aldiEquivalent
        ? {
            ...aldiRes.status,
            status: "live",
            count: 1,
            note: `Live ALDI Mamia equivalent (${aldiEquivalent.categoryLabel} · $${aldiEquivalent.entry.price.toFixed(2)})`,
          }
        : aldiRes.status;

    const retailerStatus: RetailerFeedStatus[] = [
      wowStatus,
      colesStatus,
      igaStatus,
      pricelineStatus,
      aldiFinalStatus,
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
      aldiEquivalent,
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

app.get("/prices", antiLeechGuard, priceLimit, async (req: Request, res: Response) => {
  const cleanProduct = sanitizeText(req.query.product, 120);
  if (cleanProduct.length < 2) {
    res.status(400).json({ error: "product query param required (2-120 chars)" });
    return;
  }

  const ctx = resolveCityAndState(req);
  const cleanSuburb = sanitizeText(req.query.suburb, 60) || ctx.defaultSuburb;

  // Short-circuit BEFORE live upstream retailer scrapes when caller is flagged hostile/mirage:
  // prevents bots from forcing 5 outbound scrapes, evicting real parents' priceCache, or polluting DB!
  if (req.security?.useMirage) {
    await applyProgressiveTarpit(req.security.ipHash, req.security.mirageReason);
    const warm = priceCache.get(`${cleanProduct.toLowerCase()}|${ctx.state}`);
    const payload = warm
      ? transformToGhostPrices({ ...warm, suburb: cleanSuburb }, req.security.ipHash)
      : buildSyntheticMiragePrices(cleanProduct, cleanSuburb, ctx.state, req.security.ipHash);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(payload);
    return;
  }

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

app.get("/compare", antiLeechGuard, priceLimit, async (req: Request, res: Response) => {
  const cleanProduct = sanitizeText(req.query.product, 120);
  if (cleanProduct.length < 2) {
    res.status(400).json({ error: "product query param required (2-120 chars)" });
    return;
  }

  const ctx = resolveCityAndState(req);
  const cleanSuburb = sanitizeText(req.query.suburb, 60) || ctx.defaultSuburb;

  if (req.security?.useMirage) {
    await applyProgressiveTarpit(req.security.ipHash, req.security.mirageReason);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(buildSyntheticMirageComparison(cleanProduct, cleanSuburb, ctx.state, req.security.ipHash));
    return;
  }

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

  if (req.security?.useMirage) {
    await applyProgressiveTarpit(req.security.ipHash, req.security.mirageReason);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(transformToGhostComparison(comparison, req.security.ipHash));
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=900");
  res.json(comparison);
});

// ─── Live Coles vs Woolworths Price-Gap Leaderboard ──────────────────────────

app.get("/compare/gaps", antiLeechGuard, dataDumpLimit, async (req: Request, res: Response) => {
  const ctx = resolveCityAndState(req);
  const gaps = await singleflight("compare:gaps", () => getColesVsWoolworthsGaps(72));
  const withSavings = gaps.filter((g) => g.savingsAmount >= 0.2);
  const visible = withSavings.length > 0 ? withSavings.slice(0, 40) : gaps.slice(0, 40);

  if (req.security?.useMirage) {
    await applyProgressiveTarpit(req.security.ipHash, req.security.mirageReason);
    const miraged = transformToGhostGaps(visible, req.security.ipHash);
    res.setHeader("Cache-Control", "no-store, private");
    res.json({
      region: ctx.regionLabel,
      totalMatchedPairs: miraged.length,
      gapsCount: miraged.length,
      gaps: miraged,
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=900");
  res.json({
    region: ctx.regionLabel,
    totalMatchedPairs: gaps.length,
    gapsCount: withSavings.length,
    gaps: visible,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Verified Price & Specials Ingest ────────────────────────────────────────

const ALLOWED_INGEST_RETAILERS = new Set(["Coles", "Woolworths", "IGA", "Priceline", "ALDI"]);

app.post("/prices/ingest", ingestLimit, async (req: Request, res: Response) => {
  // FAIL-CLOSED: INGEST_API_KEY must be configured in Railway and supplied via x-ingest-key
  const ingestKey = process.env.INGEST_API_KEY;
  if (!ingestKey || !timingSafeKeyMatch(req.headers["x-ingest-key"], ingestKey)) {
    res.status(403).json({ error: "Forbidden — valid ingest key required" });
    return;
  }

  const { productName, suburb = "Melbourne", state = "VIC", entries } = req.body ?? {};
  const cleanProductName = sanitizeText(productName, 140);
  const cleanSuburb = sanitizeText(suburb, 60) || "Melbourne";
  const upperState = String(state).toUpperCase() as AuStateUpper;
  const cleanState: AuStateUpper = VALID_AU_STATES.has(upperState) ? upperState : "VIC";
  if (cleanProductName.length < 2 || !Array.isArray(entries)) {
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

    const safeImageUrl =
      typeof raw.imageUrl === "string" && ALLOWED_IMAGE_URL_RE.test(raw.imageUrl)
        ? raw.imageUrl.slice(0, 400)
        : undefined;

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
      imageUrl: safeImageUrl,
      productUrl: typeof raw.productUrl === "string" ? raw.productUrl.slice(0, 400) : undefined,
      lastUpdated: nowIso,
    });
  }

  if (valid.length === 0) {
    res.status(400).json({ error: "No valid verified price entries in payload" });
    return;
  }

  await savePrices(cleanProductName, cleanSuburb, cleanState, valid);
  for (const st of VALID_AU_STATES) {
    priceCache.delete(`${cleanProductName.toLowerCase()}|${st}`);
  }

  log("info", "ingested verified prices", {
    product: cleanProductName,
    state: cleanState,
    retailer: valid[0].retailer,
    count: valid.length,
  });
  res.status(201).json({ ingested: valid.length, productName: cleanProductName, state: cleanState });
});

app.post("/specials/ingest", ingestLimit, async (req: Request, res: Response) => {
  // FAIL-CLOSED: INGEST_API_KEY must be configured in Railway and supplied via x-ingest-key
  const ingestKey = process.env.INGEST_API_KEY;
  if (!ingestKey || !timingSafeKeyMatch(req.headers["x-ingest-key"], ingestKey)) {
    res.status(403).json({ error: "Forbidden — valid ingest key required" });
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

    const safeImageUrl =
      typeof s.imageUrl === "string" && ALLOWED_IMAGE_URL_RE.test(s.imageUrl)
        ? s.imageUrl.slice(0, 400)
        : undefined;
    const safeProductUrl =
      typeof s.productUrl === "string" &&
      /^https:\/\/www\.(coles|woolworths|aldi|priceline)\.com\.au\/|^https:\/\/www\.igashop\.com\.au\//i.test(s.productUrl)
        ? s.productUrl.slice(0, 400)
        : undefined;

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
      imageUrl: safeImageUrl,
      productUrl: safeProductUrl,
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

// ─── Real Price History (Postgres + Zero-Trust Deep Archive Gate) ────────────

app.get("/prices/history", antiLeechGuard, async (req: Request, res: Response) => {
  const { product, weeks = "12" } = req.query;
  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required" });
    return;
  }

  const ctx = resolveCityAndState(req);
  const cleanSuburb = String(req.query.suburb ?? ctx.defaultSuburb);
  const requestedWeeks = Math.min(Math.max(Number(weeks) || 12, 1), 52);

  // Zero-Trust Server-Side Entitlement Gate: deep 13–52 week historical dumps require
  // a cryptographically verified Apple StoreKit 2 ES256 JWS receipt header.
  const deepArchiveAllowed =
    requestedWeeks <= 12 || verifyStoreKitJwsCrypto(req.headers["x-bubstock-receipt"]).valid;
  const effectiveWeeks = deepArchiveAllowed ? requestedWeeks : 12;

  let rows = await getPriceHistory(product.trim(), cleanSuburb, ctx.state, effectiveWeeks);
  // Fall back to VIC chain history if newer state archive is still building up (same national chain pricing)
  if (rows.length === 0 && ctx.state !== "VIC") {
    rows = await getPriceHistory(product.trim(), "Melbourne", "VIC", effectiveWeeks);
  }

  if (req.security?.useMirage) {
    await applyProgressiveTarpit(req.security.ipHash, req.security.mirageReason);
    res.setHeader("Cache-Control", "no-store, private");
    res.json({
      productName: product.trim(),
      suburb: cleanSuburb,
      state: ctx.state,
      weeks: transformToGhostHistory(rows, req.security.ipHash),
      fetchedAt: new Date().toISOString(),
    });
    return;
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

app.get("/specials", antiLeechGuard, dataDumpLimit, async (req: Request, res: Response) => {
  const ctx = resolveCityAndState(req);
  const category = String(req.query.category ?? "all").toLowerCase();
  const retailer = String(req.query.retailer ?? "all").toLowerCase();

  const all = await loadLiveSpecials();
  const filtered = all.filter((s) => {
    if (category !== "all" && s.category !== category) return false;
    if (retailer !== "all" && s.retailer.toLowerCase() !== retailer) return false;
    return true;
  });

  if (req.security?.useMirage) {
    await applyProgressiveTarpit(req.security.ipHash, req.security.mirageReason);
    const miraged = transformToGhostSpecials(filtered, req.security.ipHash);
    res.setHeader("Cache-Control", "no-store, private");
    res.json({
      region: ctx.regionLabel,
      count: miraged.length,
      specials: miraged,
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

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
      fetchAldiCityStores(city),
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

app.get("/stores", antiLeechGuard, dataDumpLimit, async (req: Request, res: Response) => {
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
  const viewerDeviceId =
    typeof req.query.deviceId === "string" ? sanitizeText(req.query.deviceId, 80) || undefined : undefined;
  const hours = Number(req.query.hours ?? 72) || 72;
  const limit = Number(req.query.limit ?? 100) || 100;

  const sightings = await getSightings({ productId, storeId, hours, limit, viewerDeviceId });
  res.json({
    region: ctx.regionLabel,
    count: sightings.length,
    sightings,
    fetchedAt: new Date().toISOString(),
  });
});

app.post("/sightings", sightingLimit, async (req: Request, res: Response) => {
  const { productId, productName, storeId, storeName, suburb, retailer, state, observedPrice, note, deviceId } =
    req.body ?? {};

  const cleanProductId = sanitizeText(productId, 120);
  const cleanProductName = sanitizeText(productName, 160);
  const cleanStoreId = sanitizeText(storeId, 120);
  const cleanStoreName = sanitizeText(storeName, 120);
  const cleanDeviceId = sanitizeText(deviceId, 80) || undefined;

  if (cleanProductId.length < 2 || cleanStoreId.length < 2 || cleanStoreName.length < 2 || !VALID_STATES.has(state)) {
    res.status(400).json({
      error: "productId, storeId, storeName, and valid state (onShelf|runningLow|likelyGone) required",
    });
    return;
  }

  const parsedPrice =
    typeof observedPrice === "number" && Number.isFinite(observedPrice) && observedPrice >= 0.5 && observedPrice <= 350
      ? Number(observedPrice.toFixed(2))
      : undefined;

  // Project Zero Shadow-Quarantine: check if this device/IP/binary is already shadow-banned.
  // Only truly Apple-PKI-verified App Attest hardware overrides IP-only hostility;
  // anonymous poisoners without deviceId fall back to ipHash so Strike-2 quarantine still traps them.
  const appleVerified = Boolean(
    req.security?.isAppleHardwareVerified &&
      !req.security?.isTamperedClient &&
      !req.security?.isReplayAttack &&
      !req.security?.isScraperUa
  );
  const strikeIdentity = cleanDeviceId ?? `ip:${req.security?.ipHash ?? hashIp(req.ip)}`;
  let shadowBan =
    Boolean(
      req.security?.isTamperedClient ||
        req.security?.isScraperUa ||
        (!appleVerified && req.security?.isHostile)
    ) ||
    (await isDeviceShadowBanned(strikeIdentity));

  // Detect coordinated out-of-stock sabotage bursts (>5 distinct stores marked likelyGone in 10 min)
  if (!shadowBan && state === "likelyGone") {
    const recentOutStores = await countRecentLikelyGoneByDevice(strikeIdentity, 10);
    if (recentOutStores >= 5) {
      await recordDeviceStrike(strikeIdentity, "likely_gone_sabotage_burst", true);
      shadowBan = true;
      log("warn", "silently shadow-banned sabotage burst device", { storesIn10m: recentOutStores });
    }
  }

  // Statistical Anti-Poisoning Guard: compare submitted shelf price against real 90-day Postgres median.
  // Strike 1 returns a friendly 422 so honest parents can fix a typo;
  // Strike 2+ silently shadow-bans the poisoner so they think their fake price worked while ZERO parents see it!
  if (parsedPrice !== undefined && cleanProductName.length >= 3) {
    const stats = await getMedianProductPrice(cleanProductName);
    if (stats && stats.median >= 2.0) {
      const minAllowed = Number(Math.max(0.5, stats.median * 0.35).toFixed(2));
      const maxAllowed = Number((stats.median * 2.25).toFixed(2));
      if (parsedPrice < minAllowed || parsedPrice > maxAllowed) {
        if (!shadowBan) {
          const strike = await recordDeviceStrike(strikeIdentity, "outlier_price_poisoning");
          if (strike.isBanned) {
            shadowBan = true;
            log("warn", "silently shadow-banned repeat price poisoner", {
              productName: cleanProductName,
              submitted: parsedPrice,
              strikes: strike.strikes,
            });
          } else {
            log("warn", "rejected outlier shelf sighting price (strike 1)", {
              productName: cleanProductName,
              submitted: parsedPrice,
              median: stats.median,
              minAllowed,
              maxAllowed,
            });
            res.status(422).json({
              error: `Price $${parsedPrice.toFixed(2)} looks far outside the verified AU median ($${stats.median.toFixed(2)}) for this item. Please double-check the shelf tag.`,
              rejectedAsOutlier: true,
              expectedRange: { min: minAllowed, max: maxAllowed, median: stats.median },
            });
            return;
          }
        }
      }
    }
  }

  const sighting = await saveSighting({
    productId: cleanProductId,
    productName: cleanProductName || undefined,
    storeId: cleanStoreId,
    storeName: cleanStoreName,
    suburb: sanitizeText(suburb, 80) || "Melbourne",
    retailer: sanitizeText(retailer, 60) || "Unknown",
    state,
    observedPrice: parsedPrice,
    note: sanitizeText(note, 240) || undefined,
    deviceId: strikeIdentity,
    isShadowBanned: shadowBan,
  });

  log("info", shadowBan ? "shadow-quarantined shelf sighting" : "shelf sighting recorded", {
    productId: sighting.productId,
    storeId: sighting.storeId,
    suburb: sighting.suburb,
    state: sighting.state,
    corroborationCount: sighting.corroborationCount,
    shadowBanned: shadowBan,
  });

  res.status(201).json({ sighting });
});

// ─── Social Shoutout Promo Submissions (TikTok, Instagram, Facebook, YouTube) ─

const ALLOWED_SOCIAL_HOST_RE =
  /^(www\.|m\.|vm\.|vt\.|mobile\.)?(tiktok\.com|instagram\.com|facebook\.com|fb\.watch|fb\.com|youtube\.com|youtu\.be|threads\.net|x\.com|twitter\.com|reddit\.com)$/i;

app.post("/promo/submit", sightingLimit, async (req: Request, res: Response) => {
  const { platform, postUrl, referralCode, city, deviceId } = req.body ?? {};
  if (typeof postUrl !== "string" || postUrl.trim().length < 16) {
    res.status(400).json({ error: "Please paste a valid public TikTok, Instagram, Facebook or YouTube post link." });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(postUrl.trim());
  } catch {
    res.status(400).json({ error: "That doesn't look like a valid link — include https://..." });
    return;
  }

  if (parsed.protocol !== "https:") {
    res.status(400).json({ error: "Link must start with https://" });
    return;
  }

  if (!ALLOWED_SOCIAL_HOST_RE.test(parsed.hostname)) {
    res.status(400).json({
      error: "Please share a link from TikTok, Instagram, Facebook, YouTube, Threads, X or Reddit.",
    });
    return;
  }

  const segments = parsed.pathname.split("/").filter((s) => s.length >= 2);
  if (segments.length < 2 && !parsed.searchParams.has("v")) {
    res.status(400).json({
      error: "Please paste the direct link to your post or video (not just the homepage).",
    });
    return;
  }

  // SSRF-safe live reachability check: NEVER follow arbitrary redirects (blocks redirect-to-internal SSRF)
  try {
    const probe = await fetch(parsed.toString(), {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(4_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BubstockLinkCheck/1.0)" },
    });
    if (probe.status === 404 || probe.status === 410) {
      res.status(400).json({ error: "That post link returned 404 (not found). Make sure your post is public and try again." });
      return;
    }
    if (probe.status >= 300 && probe.status < 400) {
      const loc = probe.headers.get("location");
      if (loc) {
        try {
          const redir = new URL(loc, parsed.toString());
          if (redir.protocol !== "https:" || !ALLOWED_SOCIAL_HOST_RE.test(redir.hostname)) {
            res.status(400).json({ error: "Social post link redirected to an unsupported host." });
            return;
          }
        } catch {
          res.status(400).json({ error: "Invalid social post redirect target." });
          return;
        }
      }
    }
  } catch {
    // Tolerate social platform network timeouts gracefully
  }

  // Verify public oEmbed / OpenGraph caption mentions #Bubstock or the user's invite code
  // when public metadata is readable (blocks pasting random cat/music videos on YouTube/TikTok/Reddit!)
  const cleanRefForCheck =
    typeof referralCode === "string" ? referralCode.trim().toLowerCase().slice(0, 12) : "";
  try {
    const hostLower = parsed.hostname.toLowerCase();
    let oembedUrl: string | null = null;
    if (hostLower.includes("youtube.com") || hostLower === "youtu.be") {
      oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.toString())}&format=json`;
    } else if (hostLower.includes("tiktok.com")) {
      oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(parsed.toString())}`;
    } else if (hostLower.includes("reddit.com")) {
      oembedUrl = `https://www.reddit.com/oembed?url=${encodeURIComponent(parsed.toString())}`;
    }
    if (oembedUrl) {
      const oe = await fetch(oembedUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(3_500),
        headers: { Accept: "application/json", "User-Agent": "BubstockLinkCheck/1.0" },
      });
      if (oe.status === 404 || oe.status === 401) {
        res.status(400).json({ error: "That video appears private or not found. Make sure your post is public!" });
        return;
      }
      if (oe.status === 200) {
        const meta = (await oe.json()) as { title?: string; author_name?: string };
        const text = `${meta.title ?? ""} ${meta.author_name ?? ""}`.toLowerCase().trim();
        if (text.length >= 4) {
          const hasBrand = text.includes("bubstock");
          const hasCode = cleanRefForCheck.length >= 5 && text.includes(cleanRefForCheck);
          if (!hasBrand && !hasCode) {
            res.status(422).json({
              error: `We couldn't spot #Bubstock${cleanRefForCheck ? ` or your code (${cleanRefForCheck.toUpperCase()})` : ""} in that video's title/caption. Add #Bubstock to your public caption and try again!`,
            });
            return;
          }
        }
      }
    }
  } catch {
    // Non-fatal if platform oEmbed is temporarily unreachable
  }

  const cleanUrl = parsed.toString().slice(0, 400);
  const cleanPlatform = typeof platform === "string" && platform.trim() ? platform.trim().slice(0, 40) : "Social";

  const saved = await saveSocialPromo({
    platform: cleanPlatform,
    postUrl: cleanUrl,
    referralCode: typeof referralCode === "string" ? referralCode.trim().slice(0, 12) : undefined,
    city: typeof city === "string" ? city.trim().slice(0, 40) : undefined,
    deviceId: sanitizeText(deviceId, 80) || req.ip,
  });

  if (saved.alreadyClaimedByDevice) {
    res.status(409).json({ error: "This device has already claimed its 2-month social shoutout reward." });
    return;
  }

  if (saved.duplicate) {
    res.status(409).json({ error: "That post link has already been submitted. Share a new post to earn credit." });
    return;
  }

  log("info", "social promo submitted", { platform: cleanPlatform, city });
  res.status(201).json({
    accepted: true,
    monthsGranted: 2,
    message: "2 months of Bubstock+ Preview unlocked! Thanks for spreading the word to Aussie parents.",
    promo: saved.record,
  });
});

app.get("/promo/recent", async (req: Request, res: Response) => {
  // Protected admin-only endpoint — prevents public scraping of submitted social URLs & referral codes.
  const adminKey = process.env.ADMIN_API_KEY ?? process.env.INGEST_API_KEY;
  if (!adminKey || !timingSafeKeyMatch(req.headers["x-admin-key"] ?? req.headers["x-ingest-key"], adminKey)) {
    res.status(403).json({ error: "Forbidden — admin key required" });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const promos = await getRecentSocialPromos(limit);
  res.json({ count: promos.length, promos });
});

// ─── Instant Price-Drop & Wednesday Half-Price Push Alert Engine ─────────────

const VALID_ALERT_CATEGORIES = new Set(["nappies", "formula", "pouch", "cereal", "snack", "other"]);

interface MatchedDropAlert {
  alertKey: string;
  specialId: string;
  title: string;
  body: string;
  retailer: string;
  productName: string;
  price: number;
  wasPrice: number;
  savingsAmount: number;
  savingsPercent: number;
  category: string;
}

function matchDropsForSubscription(
  sub: PushSubscriptionRecord,
  specials: SpecialEntry[]
): MatchedDropAlert[] {
  const matches: MatchedDropAlert[] = [];
  const seenIds = new Set<string>();
  const allowedCats = new Set(sub.alertCategories);

  // 1. Custom watched products & target prices (works for both Free 1-item & Bubstock+ unlimited)
  for (const rule of sub.watchedRules) {
    const tokens = rule.name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !["baby", "infant", "pack", "from", "with"].includes(t))
      .slice(0, 4);
    if (tokens.length === 0) continue;

    for (const sp of specials) {
      if (seenIds.has(sp.id)) continue;
      const hay = sp.name.toLowerCase();
      const hits = tokens.filter((t) => hay.includes(t)).length;
      if (hits < Math.min(2, tokens.length)) continue;

      const hitTarget = typeof rule.targetPrice === "number" && rule.targetPrice > 0 && sp.price <= rule.targetPrice;
      const hitGoodSale = sp.savingsPercent >= 25;
      if (!hitTarget && !hitGoodSale) continue;

      seenIds.add(sp.id);
      const saveStr = sp.savingsAmount.toFixed(2);
      const title = hitTarget
        ? `🎯 Target Price Hit at ${sp.retailer}!`
        : `🔥 ${sp.savingsPercent}% OFF at ${sp.retailer} — save $${saveStr}`;
      const body = `${sp.name} just dropped to $${sp.price.toFixed(2)} (was $${sp.wasPrice.toFixed(2)} — save $${saveStr}).`;
      matches.push({
        alertKey: `sp:${sp.id}:${sp.price.toFixed(2)}`,
        specialId: sp.id,
        title,
        body,
        retailer: sp.retailer,
        productName: sp.name,
        price: sp.price,
        wasPrice: sp.wasPrice,
        savingsAmount: sp.savingsAmount,
        savingsPercent: sp.savingsPercent,
        category: sp.category,
      });
    }
  }

  // 2. Bubstock+ Instant Half-Price / Big-Discount Category Drops (e.g. "Huggies Size 4 just hit 50% off at Coles — save $19!")
  if (sub.hasPlus && sub.halfPriceEnabled) {
    const minPct = Math.min(Math.max(sub.minDiscountPercent || 40, 20), 60);
    for (const sp of specials) {
      if (seenIds.has(sp.id)) continue;
      if (sp.savingsPercent < minPct) continue;
      if (allowedCats.size > 0 && !allowedCats.has(sp.category)) continue;

      seenIds.add(sp.id);
      const saveStr = sp.savingsAmount.toFixed(2);
      matches.push({
        alertKey: `sp:${sp.id}:${sp.price.toFixed(2)}`,
        specialId: sp.id,
        title: `🔥 ${sp.name.slice(0, 38)} hit ${sp.savingsPercent}% off at ${sp.retailer}`,
        body: `Now $${sp.price.toFixed(2)} (was $${sp.wasPrice.toFixed(2)}) — save $${saveStr}! Tap to compare nearby stores.`,
        retailer: sp.retailer,
        productName: sp.name,
        price: sp.price,
        wasPrice: sp.wasPrice,
        savingsAmount: sp.savingsAmount,
        savingsPercent: sp.savingsPercent,
        category: sp.category,
      });
    }
  }

  return matches
    .sort((a, b) => b.savingsPercent - a.savingsPercent || b.savingsAmount - a.savingsAmount)
    .slice(0, 5);
}

const VALID_DEVICE_ID_RE = /^[a-zA-Z0-9-]{16,80}$/;

app.post("/alerts/sync", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const {
    deviceId,
    apnsToken,
    storekitJws,
    city = "melbourne",
    state = "VIC",
    hasPlus = false,
    halfPriceEnabled = false,
    minDiscountPercent = 40,
    alertCategories = ["nappies", "formula"],
    watchedRules = [],
  } = req.body ?? {};

  const cleanDeviceId = sanitizeText(deviceId, 80);
  if (!VALID_DEVICE_ID_RE.test(cleanDeviceId)) {
    res.status(400).json({ error: "Valid UUID/deviceId required" });
    return;
  }

  // Zero-Trust server-side entitlement verification: cryptographically verify StoreKit 2 ES256 JWS
  // (Pinned Apple Root CA - G3/G2 chain + ECDSA P-256 signature) OR verified Postgres preview claim.
  const verifiedStoreKit = verifyStoreKitJwsCrypto(storekitJws ?? req.headers["x-bubstock-receipt"]).valid;
  const verifiedPreview = !verifiedStoreKit && hasPlus
    ? await hasDeviceVerifiedPromoOrReferral(cleanDeviceId)
    : false;
  const effectiveHasPlus = Boolean(hasPlus) && (verifiedStoreKit || verifiedPreview);

  const cleanToken =
    typeof apnsToken === "string"
      ? apnsToken.replace(/[^a-fA-F0-9]/g, "").slice(0, 160) || undefined
      : undefined;
  const upperState = String(state).toUpperCase() as AuStateUpper;
  const cleanState: AuStateUpper = VALID_AU_STATES.has(upperState) ? upperState : "VIC";
  const cleanCats = Array.isArray(alertCategories)
    ? alertCategories.map((c) => String(c).toLowerCase()).filter((c) => VALID_ALERT_CATEGORIES.has(c))
    : ["nappies", "formula"];
  const cleanRules: WatchedAlertRule[] = Array.isArray(watchedRules)
    ? watchedRules.slice(0, effectiveHasPlus ? 20 : 2).flatMap((r) => {
        if (!r || typeof r !== "object") return [];
        const productId = sanitizeText((r as any).productId, 80);
        const name = sanitizeText((r as any).name, 140);
        if (!productId || name.length < 3) return [];
        const tp = Number((r as any).targetPrice);
        const targetPrice = Number.isFinite(tp) && tp >= 0.5 && tp <= 250 ? Number(tp.toFixed(2)) : undefined;
        return [{ productId, name, targetPrice }];
      })
    : [];

  const callerKeyId = req.security?.isAttested ? req.security.keyId : undefined;
  const saved = await upsertPushSubscription({
    deviceId: cleanDeviceId,
    ownerKeyId: callerKeyId,
    apnsToken: cleanToken,
    city: sanitizeText(city, 30) || "melbourne",
    state: cleanState,
    hasPlus: effectiveHasPlus,
    halfPriceEnabled: effectiveHasPlus && Boolean(halfPriceEnabled),
    minDiscountPercent: Math.min(Math.max(Number(minDiscountPercent) || 40, 20), 60),
    alertCategories: cleanCats.length > 0 ? cleanCats : ["nappies", "formula"],
    watchedRules: cleanRules,
  });

  if (saved.forbidden) {
    res.status(403).json({ error: "Forbidden — device alert profile belongs to a different hardware key" });
    return;
  }

  res.status(200).json({
    synced: true,
    verifiedPlus: effectiveHasPlus,
    apnsEnabled: isApnsConfigured() && Boolean(cleanToken),
    rulesCount: cleanRules.length,
  });
});

app.get("/alerts/check", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const deviceId = sanitizeText(req.query.deviceId, 80);
  if (!VALID_DEVICE_ID_RE.test(deviceId)) {
    res.status(400).json({ error: "Valid deviceId required" });
    return;
  }

  const sub = await getPushSubscription(deviceId);
  if (!sub) {
    res.json({ alerts: [], count: 0 });
    return;
  }

  // Prevent IDOR: if bound to a hardware key, reject mismatched/unattested callers
  const callerKeyId = req.security?.isAttested ? req.security.keyId : undefined;
  if (sub.ownerKeyId && callerKeyId !== sub.ownerKeyId) {
    res.status(403).json({ error: "Forbidden — hardware key mismatch" });
    return;
  }

  const specials = await loadLiveSpecials();
  const matched = matchDropsForSubscription(sub, specials);
  const fresh: MatchedDropAlert[] = [];

  for (const item of matched.slice(0, 3)) {
    const isNew = await markPushAlertSentIfNew(deviceId, item.alertKey);
    if (isNew) fresh.push(item);
  }

  res.json({
    count: fresh.length,
    alerts: fresh,
    checkedAt: new Date().toISOString(),
  });
});

async function dispatchScheduledPushSweep(): Promise<void> {
  if (!isApnsConfigured()) return;
  const [specials, subs] = await Promise.all([loadLiveSpecials(), listActiveApnsSubscriptions()]);
  if (specials.length === 0 || subs.length === 0) return;

  let sent = 0;
  for (const sub of subs) {
    if (!sub.apnsToken) continue;
    const matches = matchDropsForSubscription(sub, specials);
    for (const drop of matches.slice(0, 2)) {
      const isNew = await markPushAlertSentIfNew(sub.deviceId, drop.alertKey);
      if (!isNew) continue;
      const result = await sendApnsPush(sub.apnsToken, {
        title: drop.title,
        body: drop.body,
        threadId: "bubstock-price-drops",
        data: { specialId: drop.specialId, retailer: drop.retailer },
      });
      if (result.ok) {
        sent++;
      } else if (result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered") {
        await clearInvalidApnsToken(sub.deviceId).catch(() => {});
        break;
      }
    }
  }
  log("info", "scheduled APNs price-drop sweep finished", { subscribers: subs.length, sent });
}

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
      ...(ctx.city !== "tasmania" ? [{ name: "ALDI", mode: "live_api" as const }] : []),
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

// ─── Zero-Knowledge E2EE Two-Parent Household Sync (Write-Proof Protected) ───

app.post("/household/sync", strictBotGuard, vaultWriteLimit, async (req: Request, res: Response) => {
  const vaultId = typeof req.body?.vaultId === "string" ? req.body.vaultId.trim().toLowerCase() : "";
  const writeToken = typeof req.body?.writeToken === "string" ? req.body.writeToken.trim().toLowerCase() : "";
  const ciphertext = typeof req.body?.ciphertext === "string" ? req.body.ciphertext.trim() : "";

  if (!/^[a-f0-9]{32,64}$/.test(vaultId) || !/^[a-f0-9]{32,64}$/.test(writeToken)) {
    res.status(400).json({ error: "Valid vaultId and writeToken required" });
    return;
  }
  if (ciphertext.length < 16 || ciphertext.length > 65_536) {
    res.status(400).json({ error: "Invalid encrypted payload size" });
    return;
  }

  const saved = await upsertHouseholdVault(vaultId, writeToken, ciphertext);
  if (saved.forbidden) {
    res.status(403).json({ error: "Forbidden — invalid household write proof" });
    return;
  }
  if (saved.storageFull) {
    res.status(503).json({ error: "Household sync capacity reached — try again later" });
    return;
  }
  res.setHeader("Cache-Control", "no-store, private");
  res.status(200).json({ synced: true, updatedAt: saved.updatedAt });
});

app.get("/household/sync/:vaultId", strictBotGuard, vaultReadLimit, async (req: Request, res: Response) => {
  const vaultId = String(req.params.vaultId ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{32,64}$/.test(vaultId)) {
    res.status(400).json({ error: "Invalid vaultId" });
    return;
  }
  const vault = await getHouseholdVault(vaultId);
  res.setHeader("Cache-Control", "no-store, private");
  if (!vault) {
    res.status(404).json({ error: "Household vault not found yet" });
    return;
  }
  res.json(vault);
});

// ─── Server-Verified Referral Codes ──────────────────────────────────────────

app.post("/referrals/register", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const code = sanitizeText(req.body?.code, 12);
  const deviceId = sanitizeText(req.body?.deviceId, 80);
  if (code.length !== 6 || !VALID_DEVICE_ID_RE.test(deviceId)) {
    res.status(400).json({ error: "Valid 6-char code and UUID deviceId required" });
    return;
  }
  await registerReferralCode(code, deviceId);
  res.status(200).json({ registered: true });
});

app.get("/referrals/status", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const code = sanitizeText(req.query.code, 12);
  const deviceId = sanitizeText(req.query.deviceId, 80);
  if (code.length !== 6 || !VALID_DEVICE_ID_RE.test(deviceId)) {
    res.status(400).json({ error: "Valid 6-char code and UUID deviceId required" });
    return;
  }
  const status = await getReferralCodeOwnerStatus(code, deviceId);
  res.setHeader("Cache-Control", "no-store, private");
  if (!status.validOwner) {
    res.status(403).json({ error: "Code not registered to this device" });
    return;
  }
  res.json({ code: code.toUpperCase(), redeemerCount: status.redeemerCount });
});

app.post("/referrals/redeem", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const code = sanitizeText(req.body?.code, 12);
  const deviceId = sanitizeText(req.body?.deviceId, 80);
  if (!VALID_DEVICE_ID_RE.test(deviceId)) {
    res.status(400).json({ accepted: false, monthsGranted: 0, message: "Valid deviceId required." });
    return;
  }
  const result = await redeemReferralCode(code, deviceId);
  res.status(result.status).json({
    accepted: result.accepted,
    monthsGranted: result.accepted ? 2 : 0,
    message: result.message,
  });
});

// ─── Mothers' Group / Playgroup Syndicate (Sybil-Resistant 3-Family Loop) ────

app.post("/groups/create", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const suburb = sanitizeText(req.body?.suburb, 60) || "Melbourne";
  const city = sanitizeText(req.body?.city, 40) || "Melbourne";
  const deviceId = sanitizeText(req.body?.deviceId, 80);
  if (!VALID_DEVICE_ID_RE.test(deviceId)) {
    res.status(400).json({ error: "Valid UUID deviceId required" });
    return;
  }
  const status = await createMothersGroup(suburb, city, deviceId, req.ip);
  res.status(201).json(status);
});

app.post("/groups/join", strictBotGuard, sightingLimit, async (req: Request, res: Response) => {
  const groupCode = sanitizeText(req.body?.groupCode, 16);
  const deviceId = sanitizeText(req.body?.deviceId, 80);
  if (groupCode.length < 4 || !VALID_DEVICE_ID_RE.test(deviceId)) {
    res.status(400).json({ error: "Valid groupCode and UUID deviceId required" });
    return;
  }
  const result = await joinMothersGroup(groupCode, deviceId, req.ip);
  if (result.sybilBlocked) {
    res.status(429).json({ error: "At least 2 different networks/households are required to unlock a 3-mum Syndicate." });
    return;
  }
  if (!result.status) {
    res.status(404).json({ error: "Mothers' Group code not found. Double-check the 6-character code." });
    return;
  }
  res.json(result.status);
});

app.get("/groups/:code", async (req: Request, res: Response) => {
  const status = await getMothersGroup(String(req.params.code ?? ""));
  if (!status) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  res.json(status);
});

// ─── Real-Time Suburb Shortage Heatmap & 90-Day Shrinkflation Detector ───────

app.get("/shortages", antiLeechGuard, dataDumpLimit, async (req: Request, res: Response) => {
  const hours = Number(req.query.hours ?? 24) || 24;
  const shortages = await getSuburbShortages(hours);
  res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120");
  res.json({
    count: shortages.length,
    shortages,
    fetchedAt: new Date().toISOString(),
  });
});

app.get("/shrinkflation", antiLeechGuard, dataDumpLimit, async (req: Request, res: Response) => {
  const product = typeof req.query.product === "string" ? sanitizeText(req.query.product, 120) : undefined;
  const alerts = await detectShrinkflation(product);
  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
  res.json({
    count: alerts.length,
    alerts,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Australian Baby Cost-of-Living Index (Cached 5m + Press SSR HTML) & SEO Pages

type CostIndexBundle = {
  index: BabyCostIndexData;
  gaps: Awaited<ReturnType<typeof getColesVsWoolworthsGaps>>;
  recalls: RecallEntry[];
};

let costIndexCacheEntry: { data: CostIndexBundle; expiresAt: number } | null = null;

async function buildCostIndexData(): Promise<CostIndexBundle> {
  if (costIndexCacheEntry && Date.now() < costIndexCacheEntry.expiresAt) {
    return costIndexCacheEntry.data;
  }
  return singleflight("cost:index:au", async () => {
    if (costIndexCacheEntry && Date.now() < costIndexCacheEntry.expiresAt) {
      return costIndexCacheEntry.data;
    }
    const [specials, gaps, { recalls }, sightings24h, shrinkAlerts, medians] = await Promise.all([
      loadLiveSpecials(),
      singleflight("compare:gaps", () => getColesVsWoolworthsGaps(72)),
      getRecallsList(),
      countRecentSightings(24),
      detectShrinkflation(),
      getCategoryMedians(),
    ]);

    const halfPrice = specials.filter((s) => s.savingsPercent >= 40).length;
    const nonZeroGaps = gaps.filter((g) => g.savingsAmount >= 0.1);
    const avgGap =
      nonZeroGaps.length > 0
        ? Number((nonZeroGaps.reduce((acc, g) => acc + g.savingsAmount, 0) / nonZeroGaps.length).toFixed(2))
        : 0;
    const biggestGap = nonZeroGaps[0]?.savingsAmount ?? 0;

    const bundle: CostIndexBundle = {
      index: {
        generatedAt: new Date().toISOString(),
        region: "Australia (VIC, NSW, QLD, WA, SA, TAS)",
        liveSpecialsCount: specials.length,
        halfPriceDealsCount: halfPrice,
        averageColesVsWooliesGapAUD: avgGap,
        biggestGapAUD: biggestGap,
        medianFormulaPriceAUD: medians.formula,
        medianNappiesPriceAUD: medians.nappies,
        activeRecallsCount: recalls.length,
        shrinkflationAlertsCount: shrinkAlerts.length,
        sightingsLast24h: sightings24h,
      },
      gaps,
      recalls,
    };
    costIndexCacheEntry = { data: bundle, expiresAt: Date.now() + 5 * 60 * 1000 };
    return bundle;
  });
}

app.get("/index/au", antiLeechGuard, dataDumpLimit, async (_req: Request, res: Response) => {
  const { index } = await buildCostIndexData();
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.json(index);
});

app.get("/au/index", dataDumpLimit, async (_req: Request, res: Response) => {
  const { index, gaps, recalls } = await buildCostIndexData();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.send(renderCostIndexPage(index, gaps, recalls));
});

app.get("/au/half-price-baby-deals", dataDumpLimit, async (_req: Request, res: Response) => {
  const specials = await loadLiveSpecials();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.send(renderHalfPriceDealsPage(specials, new Date().toISOString()));
});

app.get("/au/prices/:city/:slug", priceLimit, async (req: Request, res: Response) => {
  const rawCity = String(req.params.city ?? "").toLowerCase() as AuCity;
  const ctx = CITY_CONTEXTS[rawCity];
  const rawSlug = sanitizeText(req.params.slug, 100).toLowerCase();
  // Anti-cache-busting & anti-scraper-amplification: only render allowlisted flagship SEO slugs
  if (!ctx || !SEO_FLAGSHIP_SLUG_SET.has(rawSlug)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const productQuery = rawSlug.replace(/[^a-z0-9]+/g, " ").trim();
  const result = await resolveMultiRetailerPrices(productQuery, ctx.defaultSuburb, ctx.state);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
  res.send(renderProductCityPricePage(ctx.regionLabel, ctx.city, rawSlug, result));
});

app.get("/sitemap.xml", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(renderSitemapXml(ALL_CITIES));
});

app.get("/robots.txt", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    "User-agent: *\nAllow: /au/\nAllow: /sitemap.xml\nSitemap: https://bubstock-api-production.up.railway.app/sitemap.xml\n"
  );
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
  await dispatchScheduledPushSweep().catch((e) =>
    log("error", "cron push sweep failed", { err: (e as Error).message })
  );
});

// Wednesday 7:05 AM AEST (21:05 UTC Tuesday) — Woolworths & Coles weekly catalogue reset push!
cron.schedule("5 21 * * 2", async () => {
  specialsCache.clear();
  await loadLiveSpecials().catch((e) =>
    log("error", "wednesday catalogue refresh failed", { err: (e as Error).message })
  );
  await dispatchScheduledPushSweep().catch((e) =>
    log("error", "wednesday push sweep failed", { err: (e as Error).message })
  );
});

cron.schedule("0 3 * * *", async () => {
  storesCache.clear();
  await Promise.all(ALL_CITIES.map((c) => loadCityStores(c))).catch((e) =>
    log("error", "cron stores failed", { err: (e as Error).message })
  );
  await pruneStaleRecords().catch((e) =>
    log("error", "cron pruneStaleRecords failed", { err: (e as Error).message })
  );
});

// ─── Startup & Graceful shutdown ─────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  log("info", "bubstock-au-api listening", { port: PORT, version: "3.2.0", apnsReady: isApnsConfigured() });

  await initSchema().catch((e) =>
    log("error", "schema init failed", { err: (e as Error).message })
  );

  warmHostileCache()
    .then((count) => {
      if (count > 0) log("info", "loaded active hostile fingerprints", { count });
    })
    .catch(() => {});

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
