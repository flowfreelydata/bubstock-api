import axios from "axios";
import * as cheerio from "cheerio";
import type { RecallEntry } from "../types.js";

// Food Standards Australia New Zealand — food recall alerts
const FSANZ_URL = "https://www.foodstandards.gov.au/food-recalls/alerts";
const FSANZ_BASE = "https://www.foodstandards.gov.au";

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
  ["fish", "fish"],
  ["sesame", "sesame"],
];

// Keywords that make a recall relevant to the app's audience
const RELEVANT_TERMS = [
  "infant", "baby", "formula", "toddler", "child", "children",
  "food", "allergen", "undeclared", "contamination", "recall",
];

function extractAllergens(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, allergenId] of ALLERGEN_KEYWORDS) {
    if (lower.includes(keyword)) found.add(allergenId);
  }
  return [...found];
}

function isRelevant(text: string): boolean {
  const lower = text.toLowerCase();
  return RELEVANT_TERMS.some((t) => lower.includes(t));
}

export async function fetchFsanzRecalls(): Promise<RecallEntry[]> {
  try {
    const { data, status } = await axios.get<string>(FSANZ_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BubstockRecallBot/1.0; +https://bubstock.au/bot)",
        Accept: "text/html,application/xhtml+xml",
      },
      timeout: 12000,
    });

    if (status !== 200) return [];

    const $ = cheerio.load(data);
    const recalls: RecallEntry[] = [];
    let index = 0;

    // FSANZ renders recalls in a table or a view-content list depending on the page version.
    // Try both selectors.
    const rows = $("table.views-table tbody tr, .view-content .views-row").toArray();

    for (const el of rows) {
      const $el = $(el);

      const titleEl = $el.find("td:first-child a, .views-field-title a, h3 a").first();
      const productName = titleEl.text().trim() || $el.find("td:first-child, .views-field-title").text().trim();
      const link = titleEl.attr("href") ?? "";
      const dateText = $el
        .find(".date-display-single, .field--name-field-recall-date, td:nth-child(2)")
        .first()
        .text()
        .trim();
      const fullText = $el.text().trim();

      if (!productName || !isRelevant(fullText)) continue;

      recalls.push({
        id: `fsanz-${index++}`,
        productName: productName.replace(/\s+/g, " "),
        brand: $el.find(".views-field-field-brand, td:nth-child(3)").first().text().trim(),
        recallDate: dateText,
        reason: fullText.replace(/\s+/g, " ").slice(0, 300),
        affectedAllergens: extractAllergens(fullText),
        affectedBarcodes: [],
        recallUrl: link.startsWith("http") ? link : `${FSANZ_BASE}${link}`,
        isActive: true,
      });

      if (recalls.length >= 60) break;
    }

    console.log(`[fsanz] fetched ${recalls.length} relevant recall(s)`);
    return recalls;
  } catch (err) {
    console.error("[fsanz] fetch failed:", (err as Error).message);
    return [];
  }
}
