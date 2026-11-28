import * as cheerio from "cheerio";
import crypto from "node:crypto";
import type { RecallEntry } from "../types.js";

const FSANZ_URL = "https://www.foodstandards.gov.au/food-recalls/recall-alert";
const FSANZ_BASE = "https://www.foodstandards.gov.au";
const NSW_FOOD_URL = "https://www.foodauthority.nsw.gov.au/news/recalls";
const NSW_FOOD_BASE = "https://www.foodauthority.nsw.gov.au";
const ACCC_BABY_URL = "https://www.productsafety.gov.au/recalls?f%5B0%5D=category%3A37";
const ACCC_BASE = "https://www.productsafety.gov.au";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const ALLERGEN_NEGATION_PATTERNS: RegExp[] = [
  /\b(?:gluten|wheat|dairy|milk|lactose|soy|soya|egg|peanuts?|tree\s*nuts?|nuts?|sesame|fish|shellfish|crustacea\w*|lupins?|sulphites?|sulfites?)[\s-]+free\b/gi,
  /\bfree\s+from\s+(?:gluten|wheat|dairy|milk|lactose|soy|soya|egg|peanuts?|tree\s*nuts?|nuts?|sesame|fish|shellfish|crustacea\w*|lupins?|sulphites?|sulfites?)\b/gi,
  /\bno\s+added\s+(?:dairy|milk|lactose|gluten|wheat|soy)\b/gi,
  /\b(?:coconut\s+milk|buckwheat|eggplant|butternut|nutmeg)\b/gi,
];

const ALLERGEN_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:dairy|milk|whey|casein|lactose)\b/i, "dairy"],
  [/\b(?:soy|soya|soybean)\b/i, "soy"],
  [/\b(?:gluten|wheat|barley|rye|oats?)\b/i, "gluten"],
  [/\beggs?\b/i, "egg"],
  [/\bpeanuts?\b/i, "peanut"],
  [/\b(?:tree\s+nuts?|almonds?|cashews?|walnuts?|hazelnuts?|pistachios?|macadamias?|pecans?)\b/i, "treeNut"],
  [/\bfish\b/i, "fish"],
  [/\b(?:crustacea\w*|shellfish|prawns?|shrimp)\b/i, "shellfish"],
  [/\bsesame\b/i, "sesame"],
  [/\blupins?\b/i, "lupin"],
  [/\b(?:sulphites?|sulfites?)\b/i, "sulphite"],
];

const CANONICAL_STATE_ORDER = ["National", "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT", "Online"] as const;

function extractAllergens(text: string): string[] {
  let sanitized = text.toLowerCase();
  for (const neg of ALLERGEN_NEGATION_PATTERNS) {
    sanitized = sanitized.replace(neg, " ");
  }
  const found = new Set<string>();
  for (const [pattern, allergenId] of ALLERGEN_PATTERNS) {
    if (pattern.test(sanitized)) found.add(allergenId);
  }
  return [...found];
}

function isPlausibleBarcode(digits: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return false;
  if (/^0+$/.test(digits)) return false;
  if (/^(?:1300|1800|04\d{2}|20[12]\d(?:0[1-9]|1[0-2]))/.test(digits)) return false;
  return true;
}

function extractBarcodesFromText(text: string): string[] {
  const found = new Set<string>();

  // 1. Labeled APN / EAN / GTIN / Barcode values (may include spaces or dashes)
  const labeledRe = /\b(?:apn|ean|gtin|barcode|bar\s*code)\s*[:#-]?\s*([0-9][0-9\s-]{7,18}[0-9])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = labeledRe.exec(text)) !== null) {
    const digits = m[1].replace(/\D/g, "");
    if (isPlausibleBarcode(digits)) {
      found.add(digits);
      if (found.size >= 20) return [...found];
    }
  }

  // 2. Standalone 12–14 digit EAN/UPC/GTIN sequences (e.g. AU 93... EAN-13)
  const rawRe = /\b(\d{12,14})\b/g;
  while ((m = rawRe.exec(text)) !== null) {
    const digits = m[1];
    if (isPlausibleBarcode(digits)) {
      found.add(digits);
      if (found.size >= 20) return [...found];
    }
  }

  return [...found];
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function normalizeStateToken(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === "nsw" || s.includes("new south wales")) return "NSW";
  if (s === "vic" || s.includes("victoria")) return "VIC";
  if (s === "qld" || s.includes("queensland")) return "QLD";
  if (s === "wa" || s.includes("western australia")) return "WA";
  if (s === "sa" || s.includes("south australia")) return "SA";
  if (s === "tas" || s.includes("tasmania")) return "TAS";
  if (s === "act" || s.includes("australian capital territory")) return "ACT";
  if (s === "nt" || s.includes("northern territory")) return "NT";
  if (s.includes("national") || s.includes("all states") || s.includes("australia-wide") || s.includes("australia wide")) {
    return "National";
  }
  if (s.includes("online")) return "Online";
  return null;
}

function sortStates(states: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const raw of states) {
    const norm = normalizeStateToken(raw);
    if (norm) set.add(norm);
  }
  // If all 6+ states are explicitly listed, also mark National for easy filtering
  const individual = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].filter((s) => set.has(s));
  if (individual.length >= 6) {
    set.add("National");
  }
  return CANONICAL_STATE_ORDER.filter((s) => set.has(s));
}

function extractStatesFromText(text: string): string[] {
  const found = new Set<string>();
  if (/\b(nationally|national|all states and territories|australia-wide|australia wide|across australia)\b/i.test(text)) {
    found.add("National");
  }
  if (/\b(NSW|New South Wales)\b/.test(text)) found.add("NSW");
  if (/\b(VIC|Victoria)\b/.test(text)) found.add("VIC");
  if (/\b(QLD|Queensland)\b/.test(text)) found.add("QLD");
  if (/\b(WA|Western Australia)\b/.test(text)) found.add("WA");
  if (/\b(SA|South Australia)\b/.test(text)) found.add("SA");
  if (/\b(TAS|Tasmania)\b/.test(text)) found.add("TAS");
  if (/\b(ACT|Australian Capital Territory)\b/.test(text)) found.add("ACT");
  if (/\b(NT|Northern Territory)\b/.test(text)) found.add("NT");
  if (/\bsold online\b/i.test(text)) found.add("Online");
  return sortStates(found);
}

function parseRecallTimestamp(dateStr: string): number {
  const parsed = Date.parse(dateStr);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeTitleKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^updated[:\s-]*/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 6)
    .join(" ");
}

async function fetchFsanzPage(page: number): Promise<RecallEntry[]> {
  try {
    const r = await fetch(`${FSANZ_URL}?page=${page}`, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const $ = cheerio.load(html);
    const recalls: RecallEntry[] = [];

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
      const rawPills = $card
        .find(".recall-card__location-pill")
        .map((_j, pill) => $(pill).text().trim())
        .get()
        .filter(Boolean);

      const states = sortStates(rawPills);
      const statesLabel = states.length > 0 ? `States: ${states.join(", ")}` : "";
      const reason = [hazardType, statesLabel].filter(Boolean).join(" · ");
      const fullText = `${productName} ${brand} ${reason}`;

      recalls.push({
        id: stableId("fsanz", recallUrl || productName),
        agency: "FSANZ",
        productName,
        brand,
        recallDate: dateRaw,
        reason: reason || "Official FSANZ Australian food recall",
        states,
        affectedAllergens: extractAllergens(fullText),
        affectedBarcodes: extractBarcodesFromText(fullText),
        recallUrl,
        isActive: true,
      });
    });

    return recalls;
  } catch (err) {
    console.warn(`[fsanz] page ${page} fetch failed:`, (err as Error).message);
    return [];
  }
}

async function enrichFsanzDetails(recalls: RecallEntry[], maxLookups = 84): Promise<void> {
  const candidates = recalls.filter(
    (r) => r.agency === "FSANZ" && r.recallUrl.startsWith(FSANZ_BASE)
  );
  // Prioritize cards missing state pills first, then enrich remaining notices for EAN/APN barcodes & allergens
  const targets = [
    ...candidates.filter((r) => !r.states || r.states.length === 0),
    ...candidates.filter((r) => r.states && r.states.length > 0 && r.affectedBarcodes.length === 0),
  ].slice(0, maxLookups);

  const concurrency = 10;
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (item) => {
        try {
          const r = await fetch(item.recallUrl, {
            headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
            signal: AbortSignal.timeout(7_000),
          });
          if (!r.ok) return;
          const html = await r.text();
          const $ = cheerio.load(html);
          const bodyText = $("main, article, .region-content").first().text().replace(/\s+/g, " ");
          if (!item.states || item.states.length === 0) {
            const states = extractStatesFromText(bodyText);
            if (states.length > 0) {
              item.states = states;
              if (!/\bStates:/i.test(item.reason)) {
                item.reason = [item.reason, `States: ${states.join(", ")}`].filter(Boolean).join(" · ");
              }
            }
          }
          // Enrich allergens & EAN/APN barcodes from full official notice text
          const extraAllergens = extractAllergens(bodyText.slice(0, 2500));
          if (extraAllergens.length > 0) {
            item.affectedAllergens = [...new Set([...item.affectedAllergens, ...extraAllergens])];
          }
          const extraBarcodes = extractBarcodesFromText(bodyText.slice(0, 8000));
          if (extraBarcodes.length > 0) {
            item.affectedBarcodes = [...new Set([...item.affectedBarcodes, ...extraBarcodes])].slice(0, 20);
          }
        } catch {
          // Non-fatal enrichment timeout
        }
      })
    );
  }
}

export async function fetchFsanzRecalls(): Promise<RecallEntry[]> {
  // Fetch 8 pages (2 polite batches of 4) = up to ~96 official Australian food recalls
  // spanning National, NSW, VIC, QLD, WA, SA, TAS, ACT & NT.
  const batch1 = await Promise.all([0, 1, 2, 3].map((p) => fetchFsanzPage(p)));
  const batch2 = await Promise.all([4, 5, 6, 7].map((p) => fetchFsanzPage(p)));

  const seen = new Set<string>();
  const recalls: RecallEntry[] = [];
  for (const pageItems of [...batch1, ...batch2]) {
    for (const item of pageItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      recalls.push(item);
    }
  }

  // Enrich FSANZ notices with missing state coverage, full-text allergens & EAN/APN barcodes
  await enrichFsanzDetails(recalls, 84);
  return recalls;
}

async function fetchNswFoodPage(page: number): Promise<RecallEntry[]> {
  try {
    const url = page === 0 ? NSW_FOOD_URL : `${NSW_FOOD_URL}?page=${page}`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const $ = cheerio.load(html);
    const recalls: RecallEntry[] = [];

    $(".teaser__content").each((_i, el) => {
      const $card = $(el);
      const linkEl = $card.find("a[href*='/news/recalls/']").first();
      const productName = linkEl.text().replace(/\s+/g, " ").trim();
      const href = linkEl.attr("href") ?? "";
      if (!productName || !href) return;

      const recallUrl = href.startsWith("http") ? href : `${NSW_FOOD_BASE}${href}`;
      const dateRaw = $card.find("time, .teaser__date, .date").first().text().replace(/\s+/g, " ").trim();
      const summary = $card
        .find("p, .teaser__summary, .field--name-body")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();

      const baseReason = summary || "Official NSW Food Authority recall notice";
      const reason = `${baseReason} · States: NSW`;
      const fullText = `${productName} ${baseReason}`;

      recalls.push({
        id: stableId("nswfood", recallUrl),
        agency: "NSW Food",
        productName,
        brand: "",
        recallDate: dateRaw,
        reason: reason.slice(0, 340),
        states: ["NSW"],
        affectedAllergens: extractAllergens(fullText),
        affectedBarcodes: extractBarcodesFromText(fullText),
        recallUrl,
        isActive: true,
      });
    });

    return recalls;
  } catch (err) {
    console.warn(`[nsw-food] page ${page} fetch failed:`, (err as Error).message);
    return [];
  }
}

export async function fetchNswFoodRecalls(): Promise<RecallEntry[]> {
  const pages = await Promise.all([0, 1, 2, 3, 4].map((p) => fetchNswFoodPage(p)));
  const seen = new Set<string>();
  const recalls: RecallEntry[] = [];
  for (const items of pages) {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      recalls.push(item);
    }
  }
  return recalls;
}

export async function fetchAcccBabyRecalls(): Promise<RecallEntry[]> {
  try {
    const r = await fetch(ACCC_BABY_URL, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(12_000),
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
      const states = extractStatesFromText(fullText);
      const resolvedStates = states.length > 0 ? states : ["National"];

      recalls.push({
        id: stableId("accc", recallUrl),
        agency: "ACCC",
        productName,
        brand: "",
        recallDate: dateRaw,
        reason: (reasonRaw || "ACCC baby & children's product safety recall").slice(0, 320),
        states: resolvedStates,
        affectedAllergens: extractAllergens(fullText),
        affectedBarcodes: extractBarcodesFromText(fullText),
        recallUrl,
        isActive: true,
      });

      if (recalls.length >= 30) return false;
    });

    return recalls;
  } catch (err) {
    console.warn("[accc] fetch failed:", (err as Error).message);
    return [];
  }
}

export async function fetchAllOfficialRecalls(): Promise<RecallEntry[]> {
  const [fsanz, nswFood, accc] = await Promise.all([
    fetchFsanzRecalls(),
    fetchNswFoodRecalls(),
    fetchAcccBabyRecalls(),
  ]);

  const byId = new Map<string, RecallEntry>();
  const byTitleKey = new Map<string, RecallEntry>();

  const addOrMerge = (entry: RecallEntry) => {
    if (byId.has(entry.id)) return;
    const titleKey = normalizeTitleKey(entry.productName);
    const existing = titleKey.length >= 8 ? byTitleKey.get(titleKey) : undefined;

    if (existing) {
      // Merge state coverage & allergens into the primary FSANZ/official notice
      const mergedStates = sortStates([...(existing.states ?? []), ...(entry.states ?? [])]);
      existing.states = mergedStates;
      if (mergedStates.length > 0) {
        const cleanBase = existing.reason.replace(/\s*·?\s*States:\s*[^·]+$/i, "").trim();
        existing.reason = [cleanBase, `States: ${mergedStates.join(", ")}`].filter(Boolean).join(" · ");
      }
      existing.affectedAllergens = [...new Set([...existing.affectedAllergens, ...entry.affectedAllergens])];
      existing.affectedBarcodes = [...new Set([...existing.affectedBarcodes, ...entry.affectedBarcodes])].slice(0, 20);
      return;
    }

    byId.set(entry.id, entry);
    if (titleKey.length >= 8) {
      byTitleKey.set(titleKey, entry);
    }
  };

  for (const r of [...fsanz, ...nswFood, ...accc]) {
    addOrMerge(r);
  }

  const combined = [...byId.values()].sort(
    (a, b) => parseRecallTimestamp(b.recallDate) - parseRecallTimestamp(a.recallDate)
  );

  console.log(
    `[recalls] fetched ${fsanz.length} FSANZ + ${nswFood.length} NSW Food + ${accc.length} ACCC -> ${combined.length} unique official AU recalls`
  );
  return combined;
}
