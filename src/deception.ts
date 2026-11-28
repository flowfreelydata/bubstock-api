import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  loadActiveHostileFingerprints,
  logHoneypotHit,
  persistHostileFingerprint,
} from "./db.js";
import type {
  HeadToHeadComparison,
  PriceEntry,
  PriceGapItem,
  ProductPriceResult,
  SpecialEntry,
} from "./types.js";

// ─── Google Project Zero (P0) Deception, Honeypots, Ghost Mirage & Canary Engine ─

const DECEPTION_SECRET = (() => {
  const configured = process.env.DECEPTION_SECRET?.trim();
  if (configured && configured.length >= 16) return configured;
  console.warn("[security] DECEPTION_SECRET env var not configured — generating ephemeral per-process secret");
  return crypto.randomBytes(32).toString("hex");
})();

const MAX_HOSTILE_CACHE = 5_000;
const MAX_CONCURRENT_TARPITS = 25;
const MAX_CONCURRENT_SLOWDRIPS = 15;

interface HostileState {
  threatScore: number;
  reason: string;
  expiresAtMs: number;
  tarpitHits: number;
  lastWebhookMs?: number;
}

const hostileMap = new Map<string, HostileState>();
let activeTarpits = 0;
let activeSlowDrips = 0;

export function hashIp(rawIp: string | undefined): string {
  const clean = (rawIp ?? "unknown").trim();
  return crypto
    .createHmac("sha256", DECEPTION_SECRET)
    .update(`ip:${clean}`)
    .digest("hex")
    .slice(0, 16);
}

export async function warmHostileCache(): Promise<number> {
  const rows = await loadActiveHostileFingerprints();
  for (const r of rows) {
    hostileMap.set(r.ipHash, {
      threatScore: r.threatScore,
      reason: r.reason,
      expiresAtMs: r.expiresAtMs,
      tarpitHits: 1,
    });
  }
  return rows.length;
}

export function isHostileIp(ipHash: string): boolean {
  const entry = hostileMap.get(ipHash);
  if (!entry) return false;
  if (entry.expiresAtMs <= Date.now()) {
    hostileMap.delete(ipHash);
    return false;
  }
  return entry.threatScore >= 50;
}

export function clearHostileIp(ipHash: string): void {
  hostileMap.delete(ipHash);
}

export function markHostileIp(
  ipHash: string,
  reason: string,
  scoreDelta: number,
  meta?: { path?: string; method?: string; userAgent?: string }
): void {
  const now = Date.now();
  const prev = hostileMap.get(ipHash);
  const next: HostileState = {
    threatScore: Math.min(10_000, (prev?.threatScore ?? 0) + scoreDelta),
    reason,
    expiresAtMs: now + 7 * 24 * 3600 * 1000,
    tarpitHits: (prev?.tarpitHits ?? 0) + 1,
    lastWebhookMs: prev?.lastWebhookMs,
  };

  if (hostileMap.size >= MAX_HOSTILE_CACHE && !hostileMap.has(ipHash)) {
    const oldest = hostileMap.keys().next().value;
    if (oldest) hostileMap.delete(oldest);
  }
  hostileMap.set(ipHash, next);

  persistHostileFingerprint(ipHash, reason, scoreDelta).catch(() => {});
  if (meta?.path) {
    logHoneypotHit(
      ipHash,
      meta.path,
      meta.method ?? "GET",
      meta.userAgent ?? "",
      reason
    ).catch(() => {});
  }

  // Optional private security alert webhook (Discord / Slack / Telegram), throttled 1/10min per IP
  const webhookUrl = process.env.SECURITY_WEBHOOK_URL;
  if (webhookUrl && (!next.lastWebhookMs || now - next.lastWebhookMs > 10 * 60_000)) {
    next.lastWebhookMs = now;
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(3_000),
      body: JSON.stringify({
        content: `[Bubstock P0 Shield] Hostile actor trapped (${reason}) | fp=${ipHash} | path=${meta?.path ?? "-"} | score=${next.threatScore}`,
      }),
    }).catch(() => {});
  }
}

// ─── Progressive Tarpit (Slow-Cook Scraper Bots Safely) ─────────────────────

export async function applyProgressiveTarpit(ipHash: string, immediateReason?: string): Promise<void> {
  if (activeTarpits >= MAX_CONCURRENT_TARPITS) return;

  let entry = hostileMap.get(ipHash);
  if (!entry) {
    entry = {
      threatScore: immediateReason ? 60 : 30,
      reason: immediateReason ?? "scraper_tarpit",
      expiresAtMs: Date.now() + 24 * 3600 * 1000,
      tarpitHits: 0,
    };
    if (hostileMap.size >= MAX_HOSTILE_CACHE) {
      const oldest = hostileMap.keys().next().value;
      if (oldest) hostileMap.delete(oldest);
    }
    hostileMap.set(ipHash, entry);
  }
  entry.tarpitHits += 1;

  // Escalate delay as their bot keeps hammering: 450ms -> 1200ms -> 2400ms -> 4000ms cap
  const hits = entry.tarpitHits;
  const delayMs = hits <= 2 ? 450 : hits <= 5 ? 1200 : hits <= 10 ? 2400 : 4000;

  activeTarpits += 1;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  } finally {
    activeTarpits = Math.max(0, activeTarpits - 1);
  }
}

// ─── Deterministic PRNG & Australian Retail Price Snapping ──────────────────

function dayBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekBucket(): string {
  const now = new Date();
  const weekNum = Math.floor(now.getTime() / (7 * 86_400_000));
  return `w${weekNum}`;
}

function deterministicFloat(seed: string): number {
  const digest = crypto.createHmac("sha256", DECEPTION_SECRET).update(seed).digest();
  const n = digest.readUInt32BE(0);
  return n / 0xffffffff; // [0, 1]
}

function deterministicHex(seed: string, len = 8): string {
  return crypto.createHmac("sha256", DECEPTION_SECRET).update(seed).digest("hex").slice(0, len);
}

const AU_PRICE_ENDINGS = [0.0, 0.4, 0.5, 0.85, 0.95, 0.99];

function driftAuPrice(realPrice: number, seed: string): number {
  const u = deterministicFloat(seed);
  // Shift deterministically by either [-24%, -11%] or [+12%, +28%] — never within 10% of truth
  const factor = u < 0.45 ? 0.76 + (u / 0.45) * 0.13 : 1.12 + ((u - 0.45) / 0.55) * 0.16;
  const raw = Math.max(1.2, realPrice * factor);
  const whole = Math.floor(raw);
  const endingIdx = Math.floor(deterministicFloat(`${seed}:end`) * AU_PRICE_ENDINGS.length);
  const snapped = whole + AU_PRICE_ENDINGS[endingIdx];
  return Number(Math.max(1.0, snapped).toFixed(2));
}

// ─── Cryptographic "Barium Meal" Canary SKUs (Irrefutable Theft Proof) ──────

const CANARY_CATALOG = [
  {
    name: "MeadowBubs Organic Stage 2 Goat Infant Formula 780g",
    brand: "MeadowBubs",
    category: "formula" as const,
    retailer: "Woolworths",
    basePrice: 36,
    baseWas: 48,
    unit: "$4.62 / 100g",
  },
  {
    name: "Kookaburra Soft Ultra Dry Nappies Size 4 46 Pack",
    brand: "Kookaburra Soft",
    category: "nappies" as const,
    retailer: "Coles",
    basePrice: 21,
    baseWas: 38,
    unit: "$0.46 / ea",
  },
  {
    name: "SouthernCross Pure Pear Quinoa & Oat Baby Pouch 125g",
    brand: "SouthernCross Baby",
    category: "pouch" as const,
    retailer: "Woolworths",
    basePrice: 2,
    baseWas: 4,
    unit: "$1.80 / 100g",
  },
];

export function buildCanarySpecial(ipHash: string): SpecialEntry {
  const tag = deterministicHex(`canary:${ipHash}:${weekBucket()}`, 8);
  const pickIdx = parseInt(tag.slice(0, 2), 16) % CANARY_CATALOG.length;
  const tpl = CANARY_CATALOG[pickIdx];
  // Encode a unique cent fingerprint from tag bytes so copied listings carry forensic proof
  const centsCode = 11 + (parseInt(tag.slice(2, 4), 16) % 86); // .11 .. .96
  const price = Number((tpl.basePrice + centsCode / 100).toFixed(2));
  const wasPrice = Number((tpl.baseWas + 0.5).toFixed(2));
  const savingsAmount = Number(Math.max(0.5, wasPrice - price).toFixed(2));
  const savingsPercent = Math.round((savingsAmount / wasPrice) * 100);
  const numericSku = String(900_000 + (parseInt(tag.slice(4, 8), 16) % 99_999));

  return {
    id: `au-${tpl.retailer.toLowerCase()}-${numericSku}`,
    retailer: tpl.retailer,
    name: tpl.name,
    brand: tpl.brand,
    category: tpl.category,
    price,
    wasPrice,
    savingsAmount,
    savingsPercent,
    unit: tpl.unit,
    isInStock: true,
    lastUpdated: new Date().toISOString(),
  };
}

export function buildCanaryGapItem(ipHash: string): PriceGapItem {
  const canary = buildCanarySpecial(ipHash);
  const altPrice = Number((canary.price + 6.4).toFixed(2));
  const diff = Number((altPrice - canary.price).toFixed(2));
  const pct = Math.round((diff / altPrice) * 100);
  const nowIso = new Date().toISOString();

  const wowPrice = canary.retailer === "Woolworths" ? canary.price : altPrice;
  const colesPrice = canary.retailer === "Coles" ? canary.price : altPrice;

  return {
    productKey: canary.name.toLowerCase(),
    displayName: canary.name,
    matchQuality: "exact",
    woolworths: {
      matchedName: canary.name,
      price: wowPrice,
      wasPrice: canary.wasPrice,
      unit: canary.unit,
      isInStock: true,
      lastUpdated: nowIso,
    },
    coles: {
      matchedName: canary.name,
      price: colesPrice,
      wasPrice: canary.wasPrice,
      unit: canary.unit,
      isInStock: true,
      lastUpdated: nowIso,
    },
    cheaperRetailer: canary.retailer === "Coles" ? "Coles" : "Woolworths",
    savingsAmount: diff,
    savingsPercent: pct,
  };
}

// ─── Ghost Price Mirage Transforms (Immutable — Never Mutates Real Caches) ──

function mirageEntry(entry: PriceEntry, ipHash: string): PriceEntry {
  const seed = `ghost:${ipHash}:${dayBucket()}:${entry.retailer}:${entry.stockcode ?? entry.matchedName}`;
  const fakePrice = driftAuPrice(entry.price, seed);
  let fakeWas = entry.wasPrice ? driftAuPrice(entry.wasPrice, `${seed}:was`) : undefined;
  if (fakeWas !== undefined && fakeWas <= fakePrice) {
    fakeWas = Number((fakePrice * 1.28).toFixed(2));
  }
  const fakePct =
    fakeWas && fakeWas > fakePrice
      ? Math.round(((fakeWas - fakePrice) / fakeWas) * 100)
      : undefined;

  return {
    ...entry,
    price: fakePrice,
    wasPrice: fakeWas,
    savingsPercent: fakePct,
    isOnSale: fakeWas !== undefined ? true : deterministicFloat(`${seed}:sale`) > 0.65,
  };
}

export function transformToGhostPrices(result: ProductPriceResult, ipHash: string): ProductPriceResult {
  const entries = result.entries.map((e) => mirageEntry(e, ipHash));
  return {
    ...result,
    entries,
    aldiEquivalent: result.aldiEquivalent
      ? {
          ...result.aldiEquivalent,
          entry: mirageEntry(result.aldiEquivalent.entry, ipHash),
        }
      : undefined,
  };
}

/**
 * Zero-upstream decoy generator for trapped scrapers querying uncached/random strings:
 * returns a believable multi-retailer ProductPriceResult with ZERO upstream HTTP requests,
 * ZERO cache eviction, and ZERO PostgreSQL writes.
 */
export function buildSyntheticMiragePrices(
  productName: string,
  suburb: string,
  state: string,
  ipHash: string
): ProductPriceResult {
  const nowIso = new Date().toISOString();
  const baseSeed = `syn:${ipHash}:${dayBucket()}:${productName.toLowerCase()}`;
  const wowPrice = driftAuPrice(26.0, `${baseSeed}:wow`);
  const colesPrice = driftAuPrice(27.5, `${baseSeed}:coles`);
  const skuTag = parseInt(deterministicHex(baseSeed, 6), 16) % 899_999;

  const entries: PriceEntry[] = [
    {
      retailer: "Woolworths",
      storeName: `Woolworths Online (${state})`,
      suburb,
      state,
      matchedName: productName,
      stockcode: String(100_000 + skuTag),
      price: wowPrice,
      currency: "AUD" as const,
      unit: "each",
      isOnSale: false,
      isInStock: true,
      lastUpdated: nowIso,
    },
    {
      retailer: "Coles",
      storeName: `Coles Online (${state})`,
      suburb,
      state,
      matchedName: productName,
      stockcode: String(200_000 + skuTag),
      price: colesPrice,
      currency: "AUD" as const,
      unit: "each",
      isOnSale: false,
      isInStock: true,
      lastUpdated: nowIso,
    },
  ].sort((a, b) => a.price - b.price);

  return {
    productName,
    suburb,
    state,
    entries,
    retailerStatus: [
      { retailer: "Woolworths", status: "live", count: 1, latencyMs: 112 },
      { retailer: "Coles", status: "live", count: 1, latencyMs: 134 },
      { retailer: "IGA", status: "no_match", count: 0, latencyMs: 88 },
      { retailer: "Priceline", status: "no_match", count: 0, latencyMs: 95 },
      { retailer: "ALDI", status: "no_match", count: 0, latencyMs: 74 },
    ],
    fetchedAt: nowIso,
  };
}

export function buildSyntheticMirageComparison(
  productName: string,
  suburb: string,
  state: string,
  ipHash: string
): HeadToHeadComparison {
  const syn = buildSyntheticMiragePrices(productName, suburb, state, ipHash);
  const wow = syn.entries.find((e) => e.retailer === "Woolworths") ?? null;
  const coles = syn.entries.find((e) => e.retailer === "Coles") ?? null;
  const diff = wow && coles ? Number(Math.abs(wow.price - coles.price).toFixed(2)) : null;
  const higher = wow && coles ? Math.max(wow.price, coles.price) : 0;
  const pct = diff !== null && higher > 0 ? Math.round((diff / higher) * 100) : null;
  const cheaper: "Woolworths" | "Coles" | "Tie" | null =
    !wow || !coles
      ? null
      : diff! < 0.05
        ? "Tie"
        : coles.price < wow.price
          ? "Coles"
          : "Woolworths";
  return {
    query: productName,
    suburb,
    state,
    matchQuality: "exact",
    woolworths: wow,
    coles,
    cheaperRetailer: cheaper,
    priceDifference: diff,
    percentDifference: pct,
    unitSummary:
      cheaper && cheaper !== "Tie" && diff !== null
        ? `Save $${diff.toFixed(2)} (${pct}%) at ${cheaper}`
        : "Identical shelf price",
    retailerStatus: syn.retailerStatus,
    fetchedAt: syn.fetchedAt,
  };
}

export function transformToGhostSpecials(specials: SpecialEntry[], ipHash: string): SpecialEntry[] {
  const bucket = dayBucket();
  const miraged = specials.map((s) => {
    const seed = `ghostsp:${ipHash}:${bucket}:${s.id}`;
    const fakePrice = driftAuPrice(s.price, seed);
    const fakeWas = Number(Math.max(fakePrice + 2.0, driftAuPrice(s.wasPrice, `${seed}:was`)).toFixed(2));
    const savingsAmount = Number((fakeWas - fakePrice).toFixed(2));
    const savingsPercent = Math.max(10, Math.min(60, Math.round((savingsAmount / fakeWas) * 100)));
    return {
      ...s,
      price: fakePrice,
      wasPrice: fakeWas,
      savingsAmount,
      savingsPercent,
    };
  });

  // Inject cryptographic Barium-Meal Canary SKU near the top so stolen feeds expose themselves
  const canary = buildCanarySpecial(ipHash);
  const insertAt = Math.min(2, miraged.length);
  miraged.splice(insertAt, 0, canary);
  return miraged;
}

export function transformToGhostComparison(
  comp: HeadToHeadComparison,
  ipHash: string
): HeadToHeadComparison {
  const wow = comp.woolworths ? { ...mirageEntry(comp.woolworths, ipHash), unitMetric: comp.woolworths.unitMetric } : null;
  const coles = comp.coles ? { ...mirageEntry(comp.coles, ipHash), unitMetric: comp.coles.unitMetric } : null;

  let cheaperRetailer = comp.cheaperRetailer;
  let priceDifference = comp.priceDifference;
  let percentDifference = comp.percentDifference;
  let unitSummary = comp.unitSummary;

  if (wow && coles) {
    const diff = Number(Math.abs(wow.price - coles.price).toFixed(2));
    const higher = Math.max(wow.price, coles.price);
    priceDifference = diff;
    percentDifference = higher > 0 ? Math.round((diff / higher) * 100) : 0;
    if (diff < 0.05) {
      cheaperRetailer = "Tie";
      unitSummary = `Identical shelf price ($${wow.price.toFixed(2)})`;
    } else if (coles.price < wow.price) {
      cheaperRetailer = "Coles";
      unitSummary = `Save $${diff.toFixed(2)} (${percentDifference}%) at Coles`;
    } else {
      cheaperRetailer = "Woolworths";
      unitSummary = `Save $${diff.toFixed(2)} (${percentDifference}%) at Woolworths`;
    }
  }

  return {
    ...comp,
    woolworths: wow,
    coles,
    cheaperRetailer,
    priceDifference,
    percentDifference,
    unitSummary,
  };
}

export function transformToGhostGaps(gaps: PriceGapItem[], ipHash: string): PriceGapItem[] {
  const bucket = dayBucket();
  const miraged = gaps.map((g) => {
    const wPrice = driftAuPrice(g.woolworths.price, `ggw:${ipHash}:${bucket}:${g.productKey}`);
    const cPrice = driftAuPrice(g.coles.price, `ggc:${ipHash}:${bucket}:${g.productKey}`);
    const diff = Number(Math.abs(wPrice - cPrice).toFixed(2));
    const higher = Math.max(wPrice, cPrice);
    const pct = higher > 0 ? Math.round((diff / higher) * 100) : 0;
    const cheaper: "Woolworths" | "Coles" | "Tie" =
      diff < 0.05 ? "Tie" : cPrice < wPrice ? "Coles" : "Woolworths";
    return {
      ...g,
      woolworths: { ...g.woolworths, price: wPrice },
      coles: { ...g.coles, price: cPrice },
      cheaperRetailer: cheaper,
      savingsAmount: diff,
      savingsPercent: pct,
    };
  });
  const canaryGap = buildCanaryGapItem(ipHash);
  miraged.splice(Math.min(1, miraged.length), 0, canaryGap);
  return miraged;
}

export function transformToGhostHistory<
  T extends { week: string; retailer: string; avg_price: number; min_price: number; max_price: number }
>(rows: T[], ipHash: string): T[] {
  const bucket = dayBucket();
  return rows.map((r) => {
    const seed = `ghist:${ipHash}:${bucket}:${r.retailer}:${r.week}`;
    const avg = driftAuPrice(r.avg_price, seed);
    const min = Number(Math.max(1.0, avg * 0.94).toFixed(2));
    const max = Number((avg * 1.08).toFixed(2));
    return { ...r, avg_price: avg, min_price: min, max_price: max };
  });
}

// ─── Fake "Juicy" Honeypot Tripwire Endpoints + Controlled Slow-Drip Tarpit ─

async function sendSlowDripDecoy(
  req: Request,
  res: Response,
  contentType: string,
  chunks: string[]
): Promise<void> {
  res.status(200);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (activeSlowDrips >= MAX_CONCURRENT_SLOWDRIPS) {
    res.end(chunks.join(""));
    return;
  }

  activeSlowDrips += 1;
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (closed || res.writableEnded || res.destroyed) break;
      res.write(chunks[i]);
      if (i < chunks.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 650));
      }
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } finally {
    activeSlowDrips = Math.max(0, activeSlowDrips - 1);
  }
}

export function mountHoneypotRoutes(app: Express): void {
  const triggerTripwire = (
    req: Request,
    reason: string
  ): { ipHash: string; canaryId: string } => {
    const ipHash = hashIp(req.ip);
    const ua = String(req.headers["user-agent"] ?? "");
    markHostileIp(ipHash, reason, 120, {
      path: req.path,
      method: req.method,
      userAgent: ua,
    });
    const canaryId = deterministicHex(`trip:${ipHash}:${req.path}`, 12);
    return { ipHash, canaryId };
  };

  app.get("/api/v1/admin/export-all-prices", async (req, res) => {
    const { canaryId } = triggerTripwire(req, "honeypot_admin_export");
    await sendSlowDripDecoy(req, res, "application/json; charset=utf-8", [
      `{"status":"streaming","shard":"au-mel-prod-02","exportId":"exp_${canaryId}","totalRows":482910,"rows":[`,
      `{"sku":"AU-948210","retailer":"Woolworths","name":"MeadowBubs Organic Stage 2 780g","price":34.73},`,
      `{"sku":"AU-948211","retailer":"Coles","name":"Kookaburra Soft Size 4 46pk","price":21.47},`,
      `{"sku":"AU-948212","retailer":"IGA","name":"SouthernCross Pear Quinoa Pouch 125g","price":2.39}`,
      `],"nextCursor":"cur_${canaryId}_p2"}\n`,
    ]);
  });

  app.get("/api/v1/admin/users", async (req, res) => {
    const { canaryId } = triggerTripwire(req, "honeypot_admin_users");
    await sendSlowDripDecoy(req, res, "application/json; charset=utf-8", [
      `{"page":1,"total":14892,"auditRef":"${canaryId}","users":[`,
      `{"id":"usr_${canaryId.slice(0, 6)}","tier":"plus_yearly","region":"VIC"}`,
      `]}\n`,
    ]);
  });

  app.get(["/debug/db-dump", "/backup.sql"], async (req, res) => {
    const { canaryId } = triggerTripwire(req, "honeypot_db_dump");
    await sendSlowDripDecoy(req, res, "text/plain; charset=utf-8", [
      `-- PostgreSQL database dump (shard au-east-04 ref=${canaryId})\n`,
      `SET statement_timeout = 0;\nSET lock_timeout = 0;\n`,
      `COPY public.price_entries (id, product_name, retailer, price) FROM stdin;\n`,
      `900001\tmeadowbubs organic stage 2\tWoolworths\t34.73\n`,
      `\\.\n-- Truncated: pass ?cursor=${canaryId} for shard 2\n`,
    ]);
  });

  app.get(["/.env", "/config.json"], async (req, res) => {
    const { canaryId } = triggerTripwire(req, "honeypot_env_probe");
    if (req.path === "/config.json") {
      await sendSlowDripDecoy(req, res, "application/json; charset=utf-8", [
        `{"env":"production","region":"ap-southeast-2",`,
        `"dbReplica":"postgres://readonly:canary_${canaryId}@10.240.0.14:5432/bubstock_ro",`,
        `"ingestToken":"bstk_live_canary_${canaryId}"}\n`,
      ]);
      return;
    }
    await sendSlowDripDecoy(req, res, "text/plain; charset=utf-8", [
      `NODE_ENV=production\n`,
      `DATABASE_URL=postgres://ro_replica:canary_${canaryId}@10.240.0.14:5432/bubstock\n`,
      `INGEST_API_KEY=bstk_live_canary_${canaryId}\n`,
      `STRIPE_SECRET_KEY=sk_live_canary_${canaryId}\n`,
    ]);
  });

  app.get("/wp-login.php", async (req, res) => {
    const { canaryId } = triggerTripwire(req, "honeypot_wp_scanner");
    await sendSlowDripDecoy(req, res, "text/html; charset=utf-8", [
      `<!doctype html><html><head><title>Log In &lsaquo; Admin</title></head><body>`,
      `<form method="post" action="/wp-login.php"><input name="log"/><input type="password" name="pwd"/><input type="hidden" name="nonce" value="${canaryId}"/></form>`,
      `</body></html>\n`,
    ]);
  });

  app.all("/graphql", async (req, res) => {
    const { canaryId } = triggerTripwire(req, "honeypot_graphql_probe");
    await sendSlowDripDecoy(req, res, "application/json; charset=utf-8", [
      `{"data":{"__schema":{"queryType":{"name":"Query"},`,
      `"types":[{"name":"PriceCatalog","fields":[{"name":"exportAll","args":[{"name":"cursor","defaultValue":"${canaryId}"}]}]}]`,
      `}}}\n`,
    ]);
  });

  app.post("/internal/override-subscription", async (req, res) => {
    const { canaryId } = triggerTripwire(req, "honeypot_subscription_override");
    await sendSlowDripDecoy(req, res, "application/json; charset=utf-8", [
      `{"accepted":true,"entitlement":"bubstock_plus_lifetime",`,
      `"overrideReceipt":"jws_canary_${canaryId}","expiresAt":"2099-12-31T23:59:59Z"}\n`,
    ]);
  });
}
