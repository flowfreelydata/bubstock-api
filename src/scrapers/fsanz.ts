import axios from "axios";
import * as cheerio from "cheerio";
import type { RecallEntry } from "../types.js";

// URL updated Aug 2026 — old /food-recalls/alerts now redirects here
const FSANZ_URL = "https://www.foodstandards.gov.au/food-recalls/recall-alert";
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

// All FSANZ items are food recalls — the page is already food-specific.
// We keep the filter to avoid non-food items that may appear in future.
const RELEVANT_TERMS = [
  "infant", "baby", "formula", "toddler", "child", "children",
  "food", "seafood", "allergen", "undeclared", "contamination", "recall",
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
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
      },
      timeout: 15000,
    });

    if (status !== 200) return [];

    const $ = cheerio.load(data);
    const recalls: RecallEntry[] = [];
    let index = 0;

    // Page structure (Aug 2026):
    // .views-row > .food-recall-desc
    //   h2 > a                   — title + relative href
    //   <p><p>reason</p></p>     — HTML5 parsers split this into two sibling <p>s;
    //                              grab ALL non-date <p> text to be safe
    //   p.published-date         — "Published DD Month YYYY"
    $(".views-row").each((_i, el) => {
      const $desc = $(el).find(".food-recall-desc");
      if (!$desc.length) return;

      const titleEl = $desc.find("h2 a").first();
      const productName = titleEl.text().trim();
      const href = titleEl.attr("href") ?? "";
      const recallUrl = href.startsWith("http") ? href : `${FSANZ_BASE}${href}`;

      // Collect text from every <p> that isn't the date stamp.
      // The invalid nested <p> is parsed into two siblings by htmlparser2,
      // so this catches both the empty outer and the content-bearing inner one.
      const reasonRaw = $desc
        .find("p:not(.published-date)")
        .map((_j, p) => $(p).text().trim())
        .get()
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const dateRaw = $desc.find(".published-date").first().text()
        .replace(/^Published\s*/i, "").trim();

      const fullText = `${productName} ${reasonRaw}`;

      if (!productName || !isRelevant(fullText)) return;

      recalls.push({
        id: `fsanz-${index++}`,
        productName: productName.replace(/\s+/g, " "),
        brand: "",
        recallDate: dateRaw,
        reason: reasonRaw.slice(0, 300),
        affectedAllergens: extractAllergens(fullText),
        affectedBarcodes: [],
        recallUrl,
        isActive: true,
      });

      if (recalls.length >= 60) return false;
    });

    console.log(`[fsanz] fetched ${recalls.length} relevant recall(s)`);
    return recalls;
  } catch (err) {
    console.error("[fsanz] fetch failed:", (err as Error).message);
    return [];
  }
}
