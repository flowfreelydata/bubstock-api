import * as cheerio from "cheerio";
import crypto from "node:crypto";
import type { RecallEntry } from "../types.js";

const FSANZ_URL = "https://www.foodstandards.gov.au/food-recalls/recall-alert";
const FSANZ_BASE = "https://www.foodstandards.gov.au";
const ACCC_BABY_URL = "https://www.productsafety.gov.au/recalls?f%5B0%5D=category%3A37";
const ACCC_BASE = "https://www.productsafety.gov.au";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const ALLERGEN_KEYWORDS: [string, string][] = [
  ["dairy", "dairy"],
  ["milk", "dairy"],
  ["soy", "soy"],
  ["soya", "soy"],
  ["gluten", "gluten"],
  ["wheat", "gluten"],
  ["egg", "egg"],
  ["peanut", "peanut"],
  ["tree nut", "treeNut"],
  ["almond", "treeNut"],
  ["cashew", "treeNut"],
  ["walnut", "treeNut"],
  ["hazelnut", "treeNut"],
  ["fish", "fish"],
  ["sesame", "sesame"],
];

function extractAllergens(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, allergenId] of ALLERGEN_KEYWORDS) {
    if (lower.includes(keyword)) found.add(allergenId);
  }
  return [...found];
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

export async function fetchFsanzRecalls(): Promise<RecallEntry[]> {
  try {
    const r = await fetch(FSANZ_URL, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return [];
    const html = await r.text();

    const $ = cheerio.load(html);
    const recalls: RecallEntry[] = [];

    // 2026 FSANZ card layout: article.recall-card (plus fallback to legacy .food-recall-desc)
    $("article.recall-card").each((_i, el) => {
      const $card = $(el);
      const titleEl = $card.find(".recall-card__title a, h3 a, h2 a").first();
      const productName = titleEl.text().replace(/\s+/g, " ").trim();
      const href = titleEl.attr("href") ?? "";
      if (!productName) return;

      const recallUrl = href.startsWith("http") ? href : `${FSANZ_BASE}${href}`;
      const hazardType = $card.find(".recall-card__type-label").first().text().replace(/\s+/g, " ").trim();
      const brand = $card.find(".recall-card__business").first().text().replace(/\s+/g, " ").trim();
      const dateRaw = $card.find(".recall-card__date").first().text().replace(/\s+/g, " ").trim();
      const states = $card
        .find(".recall-card__location-pill")
        .map((_j, pill) => $(pill).text().trim())
        .get()
        .filter(Boolean);

      // Keep VIC + National recalls (or recalls with no state pill) prioritized for Melbourne
      const statesLabel = states.length > 0 ? `States: ${states.join(", ")}` : "";
      const reason = [hazardType, statesLabel].filter(Boolean).join(" · ");
      const fullText = `${productName} ${brand} ${reason}`;

      recalls.push({
        id: stableId("fsanz", recallUrl || productName),
        agency: "FSANZ",
        productName,
        brand,
        recallDate: dateRaw,
        reason: reason || "Official FSANZ food recall",
        affectedAllergens: extractAllergens(fullText),
        affectedBarcodes: [],
        recallUrl,
        isActive: true,
      });

      if (recalls.length >= 40) return false;
    });

    // Prioritize VIC / National recalls at the top for Melbourne parents
    recalls.sort((a, b) => {
      const aVic = /\b(VIC|National|Australia)\b/i.test(a.reason) ? 1 : 0;
      const bVic = /\b(VIC|National|Australia)\b/i.test(b.reason) ? 1 : 0;
      return bVic - aVic;
    });

    return recalls;
  } catch (err) {
    console.error("[fsanz] fetch failed:", (err as Error).message);
    return [];
  }
}

export async function fetchAcccBabyRecalls(): Promise<RecallEntry[]> {
  try {
    const r = await fetch(ACCC_BABY_URL, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return [];
    const html = await r.text();

    const $ = cheerio.load(html);
    const recalls: RecallEntry[] = [];

    $("article, .views-row").each((_i, el) => {
      const linkEl = $(el).find("h2 a, h3 a, .field--name-title a").first();
      const productName = linkEl.text().replace(/\s+/g, " ").trim();
      const href = linkEl.attr("href") ?? "";
      if (!productName || !href.includes("/recalls/")) return;

      const recallUrl = href.startsWith("http") ? href : `${ACCC_BASE}${href}`;
      const reasonRaw = $(el)
        .find("p, .field--name-body, .field--name-field-acccgov-summary")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const dateRaw = $(el)
        .find("time, .field--name-field-acccgov-date, .date")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();

      const fullText = `${productName} ${reasonRaw}`;
      recalls.push({
        id: stableId("accc", recallUrl),
        agency: "ACCC",
        productName,
        brand: "",
        recallDate: dateRaw,
        reason: (reasonRaw || "ACCC baby & children's product safety recall").slice(0, 320),
        affectedAllergens: extractAllergens(fullText),
        affectedBarcodes: [],
        recallUrl,
        isActive: true,
      });

      if (recalls.length >= 25) return false;
    });

    return recalls;
  } catch (err) {
    console.warn("[accc] fetch failed:", (err as Error).message);
    return [];
  }
}

export async function fetchAllOfficialRecalls(): Promise<RecallEntry[]> {
  const [fsanz, accc] = await Promise.all([fetchFsanzRecalls(), fetchAcccBabyRecalls()]);
  const seen = new Set<string>();
  const combined: RecallEntry[] = [];
  for (const r of [...fsanz, ...accc]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    combined.push(r);
  }
  console.log(`[recalls] fetched ${fsanz.length} FSANZ + ${accc.length} ACCC official recalls`);
  return combined;
}
