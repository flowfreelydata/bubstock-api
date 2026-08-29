import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { searchWoolworthsPrices } from "./scrapers/woolworths.js";
import { searchColesPrices } from "./scrapers/coles.js";
import { fetchFsanzRecalls } from "./scrapers/fsanz.js";
import { priceCache, recallCache } from "./cache.js";
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
// Returns price entries from Woolworths and Coles for the given search term.
// Suburb is used as a label only — retailer APIs don't filter by store yet.
// Cache TTL: 30 minutes.

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
  res.json(result);
});

// ─── Recalls ───────────────────────────────────────────────────────────────
//
// GET /recalls
//
// Returns all active baby/food recalls scraped from FSANZ.
// Cache TTL: 6 hours.

app.get("/recalls", async (_req, res) => {
  const cached = recallCache.get("all");
  if (cached) {
    res.json({ recalls: cached, source: "cache", fetchedAt: new Date().toISOString() });
    return;
  }

  const recalls = await fetchFsanzRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  res.json({ recalls, source: "live", fetchedAt: new Date().toISOString() });
});

// ─── Recall check ──────────────────────────────────────────────────────────
//
// GET /recalls/check?productName=aptamil+gold&barcode=93432000
//
// Checks whether a specific product appears in the recall list.
// Returns { recalled: bool, matches: [...] }.

app.get("/recalls/check", async (req, res) => {
  const { productName, barcode } = req.query;

  let recalls = recallCache.get("all");
  if (!recalls) {
    recalls = await fetchFsanzRecalls();
    recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
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
// Keeps the recall cache warm between requests. Price cache is refreshed on demand.

cron.schedule("0 */6 * * *", async () => {
  console.log("[cron] refreshing FSANZ recall cache");
  const recalls = await fetchFsanzRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  console.log(`[cron] loaded ${recalls.length} recall(s)`);
});

// ─── Startup ──────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`bubstock-api listening on port ${PORT}`);
  // Warm the recall cache so the first request is fast
  const recalls = await fetchFsanzRecalls();
  recallCache.set("all", recalls, 6 * 60 * 60 * 1000);
  console.log(`[startup] ${recalls.length} recall(s) cached`);
});
