import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { searchWoolworthsPrices } from "./scrapers/woolworths.js";
import { searchColesPrices } from "./scrapers/coles.js";
import { fetchFsanzRecalls } from "./scrapers/fsanz.js";
import { priceCache, recallCache } from "./cache.js";
import { initSchema, savePrices, getPriceHistory, upsertRecalls, loadRecalls } from "./db.js";
import type { ProductPriceResult, RecallCheckResult } from "./types.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Health ────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    cacheEntries: { price: priceCache.size(), recall: recallCache.size() },
  });
});

// ─── Prices ────────────────────────────────────────────────────────────────
//
// GET /prices?product=aptamil+gold+stage+2&suburb=fitzroy&state=VIC
//
// Scrapes live prices, caches in-memory for 30 min, and persists each entry
// to Postgres so /prices/history can build a real 12-week chart.

app.get("/prices", async (req, res) => {
  const { product, suburb = "Sydney", state = "NSW" } = req.query;

  if (!product || typeof product !== "string" || product.trim().length < 2) {
    res.status(400).json({ error: "product query param required (min 2 chars)" });
    return;
  }

  const key = `${product.trim().toLowerCase()}|${suburb}|${state}`;
  const cached = priceCache.get(key);
  if (cached) {
    res.json(cached);
    return;
  }

  const [wow, coles] = await Promise.allSettled([
    searchWoolworthsPrices(product, String(suburb), String(state)),
    searchColesPrices(product, String(suburb), String(state)),
  ]);

  const entries = [
    ...(wow.status === "fulfilled" ? wow.value : []),
    ...(coles.status === "fulfilled" ? coles.value : []),
  ];

  const result: ProductPriceResult = {
    productName: product.trim(),
    entries,
    fetchedAt: new Date().toISOString(),
  };

  priceCache.set(key, result, 30 * 60 * 1000);

  // Persist to Postgres for historical queries (non-blocking)
  savePrices(product.trim(), String(suburb), String(state), entries).catch(() => {});

  res.json(result);
});

// ─── Price history ─────────────────────────────────────────────────────────
//
// GET /prices/history?product=aptamil+gold&suburb=fitzroy&state=VIC&weeks=12
//
// Returns weekly aggregated prices from Postgres. The iOS price chart shows
// real scraped history once enough data has accumulated.

app.get("/prices/history", async (req, res) => {
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

// ─── Recalls ───────────────────────────────────────────────────────────────

app.get("/recalls", async (_req, res) => {
  const cached = recallCache.get("all");
  if (cached) {
    res.json({ recalls: cached, source: "cache", fetchedAt: new Date().toISOString() });
    return;
  }

  // Try Postgres first — persists across deploys
  const dbRecalls = await loadRecalls();
  if (dbRecalls.length > 0) {
    const recalls = dbRecalls.map(toRecallEntry);
    recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
    res.json({ recalls, source: "database", fetchedAt: new Date().toISOString() });
    return;
  }

  const recalls = await fetchFsanzRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  upsertRecalls(recalls).catch(() => {});
  res.json({ recalls, source: "live", fetchedAt: new Date().toISOString() });
});

// ─── Recall check ──────────────────────────────────────────────────────────

app.get("/recalls/check", async (req, res) => {
  const { productName, barcode } = req.query;

  let recalls = recallCache.get("all");
  if (!recalls) {
    const dbRecalls = await loadRecalls();
    recalls = dbRecalls.length > 0
      ? dbRecalls.map(toRecallEntry)
      : await fetchFsanzRecalls();
    recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
    if (dbRecalls.length === 0) upsertRecalls(recalls).catch(() => {});
  }

  const term = String(productName ?? "").toLowerCase().trim();
  const bc = String(barcode ?? "").trim();

  const matches = recalls.filter((r) => {
    if (bc && r.affectedBarcodes.includes(bc)) return true;
    if (term.length < 3) return false;
    return r.productName.toLowerCase().includes(term) ||
      r.reason.toLowerCase().includes(term);
  });

  const result: RecallCheckResult = {
    recalled: matches.length > 0,
    matches,
    checkedAt: new Date().toISOString(),
  };

  res.json(result);
});

// ─── Scheduled refresh ────────────────────────────────────────────────────

cron.schedule("0 */6 * * *", async () => {
  console.log("[cron] refreshing FSANZ recall cache");
  const recalls = await fetchFsanzRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  await upsertRecalls(recalls).catch(() => {});
  console.log(`[cron] ${recalls.length} recall(s) saved`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────

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

// ─── Startup ──────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`bubstock-api listening on port ${PORT}`);

  await initSchema().catch((e) => console.error("[startup] schema init failed:", e.message));

  // Warm recall cache from DB on cold start (fast), then refresh from FSANZ (accurate)
  const dbRecalls = await loadRecalls();
  if (dbRecalls.length > 0) {
    recallCache.set("all", dbRecalls.map(toRecallEntry), 6 * 60 * 60 * 1000);
    console.log(`[startup] ${dbRecalls.length} recall(s) loaded from database`);
  }

  const freshRecalls = await fetchFsanzRecalls();
  recallCache.set("all", freshRecalls, 6 * 60 * 60 * 1000);
  upsertRecalls(freshRecalls).catch(() => {});
  console.log(`[startup] ${freshRecalls.length} recall(s) refreshed from FSANZ`);
});
