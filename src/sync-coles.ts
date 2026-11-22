/**
 * Melbourne Coles + Woolworths Head-to-Head Sync Worker.
 *
 * Run from any Australian IP (`npm run sync:coles`) to politely fetch real live
 * Coles VIC prices & baby specials, pair them with live Woolworths prices, and
 * ingest verified snapshots directly into the deployed Railway PostgreSQL API.
 *
 * Zero synthetic data — only verified live retailer prices.
 */
import "dotenv/config";
import { searchColesPrices, fetchColesBabySpecials } from "./scrapers/coles.js";
import { searchWoolworthsPrices } from "./scrapers/woolworths.js";
import { pickBestMatch } from "./matcher.js";

const API_BASE = process.env.BUBSTOCK_API_URL ?? "https://bubstock-api-production.up.railway.app";
const INGEST_KEY = process.env.INGEST_API_KEY;

// Top Melbourne baby essentials to keep freshly synced across BOTH Coles & Woolworths
const MELBOURNE_KEY_PRODUCTS = [
  "Aptamil Gold+ Stage 1 Infant Formula 900g",
  "Aptamil Gold+ Stage 2 Follow-On Formula 900g",
  "Aptamil Gold+ Stage 3 Toddler Milk 900g",
  "Aptamil Gold+ Stage 4 Junior Milk 900g",
  "a2 Platinum Stage 1 Infant Formula 900g",
  "a2 Platinum Stage 2 Follow-On Formula 900g",
  "a2 Platinum Stage 3 Toddler Milk 900g",
  "Bellamy's Organic Step 1 Infant Formula 900g",
  "Bellamy's Organic Step 2 Follow-On Formula 900g",
  "Bellamy's Organic Step 3 Toddler Milk 900g",
  "Karicare Stage 1 Infant Formula 900g",
  "Karicare Stage 2 Follow-On Formula 900g",
  "Karicare Stage 3 Toddler Milk 900g",
  "Alula Gold Newborn Infant Formula 900g",
  "Alula Gold Follow-On Formula 900g",
  "Alula Gold Toddler Milk 900g",
  "NAN Supremepro Stage 1 Infant Formula 800g",
  "NAN Comfort Stage 1 Infant Formula 800g",
  "Bubs Goat Milk Stage 1 Infant Formula 800g",
  "Oli6 Dairy Goat Stage 1 Infant Formula 800g",
  "Huggies Ultimate Nappies Size 1 Newborn",
  "Huggies Ultimate Nappies Size 2 Infant",
  "Huggies Ultra Dry Nappies Size 3",
  "Huggies Ultra Dry Nappies Size 4",
  "Huggies Ultra Dry Nappies Size 5",
  "Huggies Ultra Dry Nappy Pants Size 4",
  "Huggies Ultra Dry Nappy Pants Size 5",
  "BabyLove Cosifit Nappies Size 3",
  "BabyLove Nappy Pants Size 4",
  "Rafferty's Garden Banana Pear Mango Pouch 120g",
  "Rafferty's Garden Apple Banana Peach Pouch 120g",
  "Rafferty's Garden Pumpkin Apple Sweetcorn Pouch 120g",
  "Only Organic Banana Blueberry Quinoa Pouch 120g",
  "Heinz Pear Puree Baby Food 110g",
  "Heinz Apple Mango Baby Food Pouch 120g",
  "Farex Original Multigrain Baby Cereal 125g",
  "Farex Pear & Banana Baby Rice Cereal 125g",
  "Little Bellies Sweetcorn Round-a-Bouts 12g",
  "Little Bellies Blueberry Puffs 12g",
  "Little Bellies Yoghurt Melts 20g",
  "Tamar Valley Kids Greek Yoghurt Pouch 110g",
  "Vaalia Kids Yoghurt Pouch 140g",
];

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(INGEST_KEY ? { "x-ingest-key": INGEST_KEY } : {}),
  };
}

async function ingestPrices(productName: string, entries: any[]) {
  if (entries.length === 0) return false;
  const r = await fetch(`${API_BASE}/prices/ingest`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ productName, suburb: "Melbourne", entries }),
    signal: AbortSignal.timeout(15_000),
  });
  return r.ok;
}

async function run() {
  console.log(`🔄 Syncing live Melbourne Coles + Woolworths prices -> ${API_BASE}`);

  // 1. Sync live Coles baby specials first
  const colesSpecials = await fetchColesBabySpecials();
  if (colesSpecials.length > 0) {
    const r = await fetch(`${API_BASE}/specials/ingest`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ specials: colesSpecials }),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`✅ Ingested ${colesSpecials.length} live Coles baby specials (HTTP ${r.status})`);
  }

  let matchedBoth = 0;
  let colesOnly = 0;
  let wowOnly = 0;

  for (const product of MELBOURNE_KEY_PRODUCTS) {
    const [colesRes, wowRes] = await Promise.all([
      searchColesPrices(product, "Melbourne", "VIC"),
      searchWoolworthsPrices(product, "Melbourne", "VIC"),
    ]);

    const bestColes = pickBestMatch(product, colesRes.entries);
    const bestWow = pickBestMatch(product, wowRes.entries);

    const toIngest = [...colesRes.entries.slice(0, 5), ...wowRes.entries.slice(0, 5)];
    if (toIngest.length > 0) {
      await ingestPrices(product, toIngest);
    }

    if (bestColes && bestWow) {
      matchedBoth++;
      const diff = (bestWow.price - bestColes.price).toFixed(2);
      const winner =
        Math.abs(bestWow.price - bestColes.price) < 0.05
          ? "TIE"
          : bestColes.price < bestWow.price
            ? `COLES -$${Math.abs(Number(diff)).toFixed(2)}`
            : `WOOLWORTHS -$${Math.abs(Number(diff)).toFixed(2)}`;
      console.log(
        `  ✅ ${product}: Coles $${bestColes.price.toFixed(2)} vs Woolworths $${bestWow.price.toFixed(2)} → ${winner}`
      );
    } else if (bestColes) {
      colesOnly++;
      console.log(`  🟡 ${product}: Coles $${bestColes.price.toFixed(2)} (no Woolworths exact match)`);
    } else if (bestWow) {
      wowOnly++;
      console.log(`  🟢 ${product}: Woolworths $${bestWow.price.toFixed(2)} (no Coles exact match)`);
    }

    // Polite 600ms pacing between queries
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`\n🏁 Sync complete! Exact Coles vs Woolworths pairs: ${matchedBoth} | Coles only: ${colesOnly} | Woolies only: ${wowOnly}`);
}

run().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
