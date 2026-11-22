import type { PriceEntry } from "./types.js";

export interface ProductDNA {
  brand: string | null;
  stage: number | null;       // Formula stage 1..4
  nappySize: number | null;   // Nappy size 1..6
  grams: number | null;       // Total weight in grams (e.g. 900g, 120g)
  ml: number | null;          // Total volume in mL
  packCount: number | null;   // Count in pack (e.g. 54 pack, 5 pack)
  isSachet: boolean;
  isFormula: boolean;
  isNappy: boolean;
  isOrganic: boolean;
  isGoat: boolean;
  isSoy: boolean;
  tokens: Set<string>;
}

const KNOWN_BRANDS = [
  "aptamil",
  "a2",
  "bellamy",
  "karicare",
  "alula",
  "nan",
  "s-26",
  "s26",
  "bubs",
  "oli6",
  "novalac",
  "neocate",
  "huggies",
  "babylove",
  "millie moon",
  "tooshies",
  "rascal",
  "rafferty",
  "only organic",
  "heinz",
  "farex",
  "little bellies",
  "tamar valley",
  "vaalia",
  "annabel karmel",
  "bellies",
  "whole kids",
  "kiddylicious",
  "sprout",
  "cerelac",
  "mamia",
  "cub",
];

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "months", "month", "years", "year",
  "baby", "infant", "toddler", "kids", "child", "pack", "tin", "pouch",
  "premium", "plus", "gold", "food", "milk", "drink", "powder", "formula",
]);

export function parseProductDNA(rawText: string): ProductDNA {
  const lower = rawText
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let brand: string | null = null;
  for (const b of KNOWN_BRANDS) {
    if (lower.includes(b)) {
      brand = b === "s26" ? "s-26" : b === "bellies" ? "little bellies" : b;
      break;
    }
  }

  // Extract formula stage (1..4)
  let stage: number | null = null;
  const stageMatch =
    lower.match(/\bstage\s*([1-4])\b/) ??
    lower.match(/\bgold\s+([1-4])\b/) ??
    lower.match(/\bplatinum\s+([1-4])\b/) ??
    lower.match(/\bpro\s+([1-4])\b/) ??
    lower.match(/\bstep\s*([1-4])\b/);
  if (stageMatch) {
    stage = Number(stageMatch[1]);
  } else if (/\b(newborn|from birth|0\s*[-–to]+\s*6)\b/.test(lower) && /formula/.test(lower)) {
    stage = 1;
  } else if (/\b(follow\s*[- ]?on|6\s*[-–to]+\s*12)\b/.test(lower) && /formula/.test(lower)) {
    stage = 2;
  } else if (/\btoddler\b/.test(lower) && /\b(milk|formula)\b/.test(lower)) {
    stage = 3;
  } else if (/\bjunior\b/.test(lower) && /\b(milk|formula)\b/.test(lower)) {
    stage = 4;
  }

  // Extract nappy size (1..6)
  let nappySize: number | null = null;
  const sizeMatch = lower.match(/\bsize\s*([1-6])\b/);
  if (sizeMatch) nappySize = Number(sizeMatch[1]);

  // Extract weight in grams (handles "900g", "1.2kg", "120 g")
  let grams: number | null = null;
  const kgMatch = lower.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  const gMatch = lower.match(/(\d+(?:\.\d+)?)\s*g\b/);
  if (kgMatch) {
    grams = Math.round(Number(kgMatch[1]) * 1000);
  } else if (gMatch) {
    grams = Math.round(Number(gMatch[1]));
  }

  // Extract volume in mL
  let ml: number | null = null;
  const mlMatch = lower.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (mlMatch) ml = Math.round(Number(mlMatch[1]));

  // Extract pack count ("54 pack", "48pk", "5 pack", "6 x 120g")
  let packCount: number | null = null;
  const pkMatch = lower.match(/(\d+)\s*(?:pack|pk|nappies|ea|sachets?)\b/);
  if (pkMatch) packCount = Number(pkMatch[1]);

  const isSachet = /\b(sachet|sachets|travel|single serve|stick pack)\b/.test(lower) || (packCount !== null && packCount <= 10 && /formula/.test(lower) && (grams === null || grams < 300));
  const isFormula = /\b(formula|toddler milk|junior milk|follow-on|follow on)\b/.test(lower);
  const isNappy = /\b(nappy|nappies|swimmers|drynites|pull-ups)\b/.test(lower);
  const isOrganic = /\borganic\b/.test(lower);
  const isGoat = /\bgoat\b/.test(lower);
  const isSoy = /\bsoy\b/.test(lower);

  const tokens = new Set(
    lower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
  );

  return {
    brand,
    stage,
    nappySize,
    grams,
    ml,
    packCount,
    isSachet,
    isFormula,
    isNappy,
    isOrganic,
    isGoat,
    isSoy,
    tokens,
  };
}

/**
 * Scores how accurately a scraped candidate entry matches the target query/product.
 * Returns -1 for hard mismatches (wrong brand, wrong formula stage, sachet vs tin,
 * wrong nappy size, wrong milk base).
 */
export function matchScore(query: string, candidate: PriceEntry): number {
  const q = parseProductDNA(query);
  const c = parseProductDNA(`${candidate.brand ?? ""} ${candidate.matchedName} ${candidate.unit}`);

  // Hard guard 1: brand must match if query specifies a known brand
  if (q.brand && c.brand && q.brand !== c.brand) return -1;
  if (q.brand && !c.brand && !candidate.matchedName.toLowerCase().includes(q.brand)) return -1;

  // Hard guard 2: never match sachets/trial packs when user searched for a standard formula tin
  if (c.isSachet && !q.isSachet) return -1;

  // Hard guard 3: formula stage must match when specified
  if (q.stage !== null && c.stage !== null && q.stage !== c.stage) return -1;

  // Hard guard 4: nappy size must match when specified
  if (q.nappySize !== null && c.nappySize !== null && q.nappySize !== c.nappySize) return -1;

  // Hard guard 5: goat/soy base must match
  if (q.isGoat !== c.isGoat && (q.isFormula || c.isFormula)) return -1;
  if (q.isSoy !== c.isSoy && (q.isFormula || c.isFormula)) return -1;

  // Hard guard 6: formula should not match non-formula (e.g. bottle/book/biscuit)
  if (q.isFormula && !c.isFormula && candidate.price < 12) return -1;

  // Compute positive similarity score
  let score = 0;
  if (q.brand && c.brand === q.brand) score += 35;
  if (q.stage !== null && c.stage === q.stage) score += 25;
  if (q.nappySize !== null && c.nappySize === q.nappySize) score += 25;

  // Weight proximity (e.g. 900g vs 900g = +20, 900g vs 800g = +10)
  if (q.grams && c.grams) {
    const ratio = Math.min(q.grams, c.grams) / Math.max(q.grams, c.grams);
    if (ratio >= 0.95) score += 20;
    else if (ratio >= 0.8) score += 10;
    else if (ratio < 0.5) return -1; // radically different pack size (e.g. 120g vs 900g)
  }

  // Token overlap
  let overlap = 0;
  for (const t of q.tokens) {
    if (c.tokens.has(t)) overlap++;
  }
  const tokenRatio = q.tokens.size > 0 ? overlap / q.tokens.size : 0;
  score += Math.round(tokenRatio * 30);

  if (q.isOrganic === c.isOrganic) score += 4;

  // Must meet minimum relevance threshold
  if (score < 22) return -1;
  return score;
}

/**
 * Computes a standardized numeric unit price ($ per 100g, $ per 100mL, or $ per item)
 * so different pack sizes can be compared apples-to-apples.
 */
export function computeUnitMetric(entry: PriceEntry): {
  value: number;
  label: string;
} | null {
  // First try parsing the retailer's own unit string (e.g. "$3.33 / 100G" or "$0.52 / 1EA")
  const m = entry.unit.match(/\$(\d+(?:\.\d+)?)\s*(?:\/|per)\s*(100\s*g|100\s*ml|1\s*kg|1\s*ea|1\s*each|100\s*ea)/i);
  if (m) {
    const num = Number(m[1]);
    const basis = m[2].toLowerCase().replace(/\s+/g, "");
    if (Number.isFinite(num) && num > 0) {
      if (basis === "1kg") return { value: Number((num / 10).toFixed(2)), label: `$${(num / 10).toFixed(2)} / 100g` };
      if (basis === "100ea") return { value: Number((num / 100).toFixed(2)), label: `$${(num / 100).toFixed(2)} / ea` };
      if (basis === "1ea" || basis === "1each") return { value: Number(num.toFixed(2)), label: `$${num.toFixed(2)} / ea` };
      if (basis === "100g") return { value: Number(num.toFixed(2)), label: `$${num.toFixed(2)} / 100g` };
      if (basis === "100ml") return { value: Number(num.toFixed(2)), label: `$${num.toFixed(2)} / 100mL` };
    }
  }

  // Fallback: compute directly from weight or pack count in title
  const dna = parseProductDNA(entry.matchedName);
  if (dna.grams && dna.grams >= 20) {
    const per100g = Number(((entry.price / dna.grams) * 100).toFixed(2));
    return { value: per100g, label: `$${per100g.toFixed(2)} / 100g` };
  }
  if (dna.ml && dna.ml >= 20) {
    const per100ml = Number(((entry.price / dna.ml) * 100).toFixed(2));
    return { value: per100ml, label: `$${per100ml.toFixed(2)} / 100mL` };
  }
  if (dna.packCount && dna.packCount >= 4) {
    const perEa = Number((entry.price / dna.packCount).toFixed(2));
    return { value: perEa, label: `$${perEa.toFixed(2)} / ea` };
  }
  return null;
}

/**
 * Picks the single most accurate entry for a query from a retailer's list.
 * Filters out sachets, wrong stages, and wrong brands.
 */
export function pickBestMatch(query: string, entries: PriceEntry[]): PriceEntry | null {
  let best: PriceEntry | null = null;
  let bestScore = -1;

  for (const entry of entries) {
    const s = matchScore(query, entry);
    if (s < 0) continue;
    if (s > bestScore || (s === bestScore && best && entry.price < best.price)) {
      bestScore = s;
      best = entry;
    }
  }
  return best;
}

/**
 * Evaluates whether a Woolworths entry and a Coles entry are the exact same SKU/size
 * or a unit-adjusted match.
 */
export function classifyPairMatch(
  wow: PriceEntry,
  coles: PriceEntry
): "exact" | "unit_matched" {
  const w = parseProductDNA(wow.matchedName);
  const c = parseProductDNA(coles.matchedName);

  if (w.grams && c.grams) {
    const ratio = Math.min(w.grams, c.grams) / Math.max(w.grams, c.grams);
    return ratio >= 0.95 ? "exact" : "unit_matched";
  }
  if (w.packCount && c.packCount) {
    return w.packCount === c.packCount ? "exact" : "unit_matched";
  }
  return "exact";
}
