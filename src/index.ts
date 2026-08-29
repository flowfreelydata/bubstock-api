import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { searchWoolworthsPrices } from "./scrapers/woolworths.js";
import { searchColesPrices } from "./scrapers/coles.js";
import { fetchFsanzRecalls } from "./scrapers/fsanz.js";
import { priceCache, recallCache } from "./cache.js";
import {
  initSchema,
  savePrices,
  getPriceHistory,
  upsertRecalls,
  loadRecalls,
  pingDB,
} from "./db.js";
import type { ProductPriceResult, RecallCheckResult } from "./types.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// ─── Structured logger ────────────────────────────────────────────────────────
// Emits JSON so Railway's log aggregator can index fields.

function log(level: "info" | "warn" | "error", msg: string, extra?: object) {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({ level, ts: new Date().toISOString(), msg, ...extra })
  );
}

// ─── Security & global middleware ─────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false })); // CSP off — pure JSON API
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "64kb" }));

// Attach a short request ID to every request for log correlation
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).id = Math.random().toString(36).slice(2, 10);
  next();
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
// General: 120 req / min (enough for any legitimate mobile client).
// Price: 15 req / min — each call fans out to 2 retailer scrapes.

const generalLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down" },
});

const priceLimit = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Price lookup rate limit exceeded — wait a minute" },
});

app.use(generalLimit);

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const dbOk = await pingDB();
  const status = dbOk ? "ok" : "degraded";
  res.status(dbOk ? 200 : 503).json({
    status,
    db: dbOk ? "connected" : "unreachable",
    timestamp: new Date().toISOString(),
    cache: { price: priceCache.size(), recall: recallCache.size() },
  });
});

// ─── Prices ───────────────────────────────────────────────────────────────────
//
// GET /prices?product=aptamil+gold+stage+2&suburb=fitzroy&state=VIC
//
// Scrapes live prices, caches 30 min, persists to Postgres for /prices/history.

app.get("/prices", priceLimit, async (req: Request, res: Response) => {
  const { product, suburb = "Melbourne", state = "VIC" } = req.query;

  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required (min 2 chars)" });
    return;
  }

  const term = product.trim().toLowerCase();
  const key = `${term}|${suburb}|${state}`;
  const cached = priceCache.get(key);
  if (cached) {
    res.json(cached);
    return;
  }

  log("info", "price lookup", { term, suburb, state, id: (req as any).id });

  const [wow, coles] = await Promise.allSettled([
    searchWoolworthsPrices(product.trim(), String(suburb), String(state)),
    searchColesPrices(product.trim(), String(suburb), String(state)),
  ]);

  const entries = [
    ...(wow.status === "fulfilled" ? wow.value : []),
    ...(coles.status === "fulfilled" ? coles.value : []),
  ];

  if (wow.status === "rejected")
    log("warn", "woolworths scrape rejected", { reason: String(wow.reason) });
  if (coles.status === "rejected")
    log("warn", "coles scrape rejected", { reason: String(coles.reason) });

  const result: ProductPriceResult = {
    productName: product.trim(),
    entries,
    fetchedAt: new Date().toISOString(),
  };

  priceCache.set(key, result, 30 * 60 * 1000);
  savePrices(product.trim(), String(suburb), String(state), entries).catch((e) =>
    log("error", "savePrices failed", { err: e.message })
  );

  log("info", "price result", { term, entries: entries.length, id: (req as any).id });
  res.json(result);
});

// ─── Price history ────────────────────────────────────────────────────────────
//
// GET /prices/history?product=aptamil+gold&suburb=fitzroy&state=VIC&weeks=12

app.get("/prices/history", async (req: Request, res: Response) => {
  const { product, suburb = "Melbourne", state = "VIC", weeks = "12" } = req.query;

  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required" });
    return;
  }

  const rows = await getPriceHistory(
    product.trim(),
    String(suburb),
    String(state),
    Math.min(Number(weeks) || 12, 52)
  );

  res.json({
    productName: product.trim(),
    suburb: String(suburb),
    state: String(state),
    weeks: rows,
    fetchedAt: new Date().toISOString(),
  });
});

// ─── Recalls ─────────────────────────────────────────────────────────────────

app.get("/recalls", async (_req, res) => {
  const cached = recallCache.get("all");
  if (cached) {
    res.json({ recalls: cached, source: "cache", fetchedAt: new Date().toISOString() });
    return;
  }

  const dbRecalls = await loadRecalls();
  if (dbRecalls.length > 0) {
    const recalls = dbRecalls.map(toRecallEntry);
    recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
    res.json({ recalls, source: "database", fetchedAt: new Date().toISOString() });
    return;
  }

  const recalls = await fetchFsanzRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  upsertRecalls(recalls).catch((e) =>
    log("error", "upsertRecalls failed", { err: e.message })
  );
  res.json({ recalls, source: "live", fetchedAt: new Date().toISOString() });
});

// ─── Recall check ─────────────────────────────────────────────────────────────

app.get("/recalls/check", async (req: Request, res: Response) => {
  const { productName, barcode } = req.query;

  let recalls = recallCache.get("all");
  if (!recalls) {
    const dbRecalls = await loadRecalls();
    recalls =
      dbRecalls.length > 0
        ? dbRecalls.map(toRecallEntry)
        : await fetchFsanzRecalls();
    recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
    if (dbRecalls.length === 0)
      upsertRecalls(recalls).catch((e) =>
        log("error", "upsertRecalls failed", { err: e.message })
      );
  }

  const term = String(productName ?? "").toLowerCase().trim();
  const bc = String(barcode ?? "").trim();

  const matches = recalls.filter((r) => {
    if (bc && r.affectedBarcodes.includes(bc)) return true;
    if (term.length < 3) return false;
    return (
      r.productName.toLowerCase().includes(term) ||
      r.reason.toLowerCase().includes(term)
    );
  });

  const result: RecallCheckResult = {
    recalled: matches.length > 0,
    matches,
    checkedAt: new Date().toISOString(),
  };

  res.json(result);
});

// ─── Error middleware ─────────────────────────────────────────────────────────
// Catches any unhandled async errors that bubble up via next(err).

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  log("error", "unhandled request error", {
    err: err.message,
    path: req.path,
    id: (req as any).id,
  });
  res.status(500).json({ error: "Internal server error" });
});

// ─── Scheduled refresh ────────────────────────────────────────────────────────

cron.schedule("0 */6 * * *", async () => {
  log("info", "cron: refreshing FSANZ recall cache");
  const recalls = await fetchFsanzRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  await upsertRecalls(recalls).catch((e) =>
    log("error", "cron upsertRecalls failed", { err: e.message })
  );
  log("info", "cron: recalls refreshed", { count: recalls.length });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toRecallEntry(r: import("./db.js").RecallRow) {
  return {
    id: r.fsanz_id,
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

// ─── Startup ─────────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  log("info", `bubstock-api listening`, { port: PORT });

  await initSchema().catch((e) =>
    log("error", "schema init failed", { err: e.message })
  );

  // Warm recall cache from DB (fast), then refresh from FSANZ (accurate)
  const dbRecalls = await loadRecalls();
  if (dbRecalls.length > 0) {
    recallCache.set("all", dbRecalls.map(toRecallEntry), 6 * 60 * 60 * 1000);
    log("info", "startup: recalls loaded from database", { count: dbRecalls.length });
  }

  const freshRecalls = await fetchFsanzRecalls();
  recallCache.set("all", freshRecalls, 6 * 60 * 60 * 1000);
  upsertRecalls(freshRecalls).catch((e) =>
    log("error", "startup upsertRecalls failed", { err: e.message })
  );
  log("info", "startup: recalls refreshed from FSANZ", { count: freshRecalls.length });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Railway sends SIGTERM before stopping a container. We finish in-flight
// requests (5 s grace), then close the DB pool cleanly.

async function shutdown(signal: string) {
  log("info", `${signal} received — shutting down gracefully`);
  server.close(async () => {
    log("info", "HTTP server closed");
    const { pool } = await import("./db.js");
    await pool.end().catch(() => {});
    log("info", "DB pool drained — exiting");
    process.exit(0);
  });

  // Hard exit if graceful shutdown takes too long
  setTimeout(() => {
    log("warn", "graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 8_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Log unhandled rejections rather than crashing silently
process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", { reason: String(reason) });
});
