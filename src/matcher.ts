import type { PriceEntry } from "./types.js";

export interface ProductDNA {
  brand: string | null;
  variant: string | null;     // e.g. supremepro, comfort, cosifit, nappy pants, ultra dry, ultimate, melts, sticks
  stage: number | null;       // Formula stage 1..4
  nappySize: number | null;   // Nappy size 1..6
  grams: number | null;       // Total weight in grams
  ml: number | null;          // Total volume in mL
  packCount: number | null;   // Count in pack (e.g. 44 pack, 200 nappies)
  isSachet: boolean;
  isFormula: boolean;
  isNappy: boolean;
  isOrganic: boolean;
  isGoat: boolean;
  isSoy: boolean;
  tokens: Set<string>;
}

const KNOWN_BRANDS: Array<{ canonical: string; pattern: RegExp }> = [
  { canonical: "aptamil", pattern: /\baptamil\b/ },
  { canonical: "a2", pattern: /\ba2\b/ },
  { canonical: "bellamy", pattern: /\bbellamy'?s?\b/ },
  { canonical: "karicare", pattern: /\bkaricare\b/ },
  { canonical: "alula", pattern: /\balula\b/ },
  { canonical: "nan", pattern: /\bnan\b/ },
  { canonical: "s-26", pattern: /\bs-?26\b/ },
  { canonical: "bubs", pattern: /\bbubs\b/ },
  { canonical: "oli6", pattern: /\boli6\b/ },
  { canonical: "novalac", pattern: /\bnovalac\b/ },
  { canonical: "neocate", pattern: /\bneocate\b/ },
  { canonical: "huggies", pattern: /\bhuggies\b/ },
  { canonical: "babylove", pattern: /\bbabylove\b/ },
  { canonical: "millie moon", pattern: /\bmillie\s+moon\b/ },
  { canonical: "tooshies", pattern: /\btooshies\b/ },
  { canonical: "rascal", pattern: /\brascal\b/ },
  { canonical: "rafferty", pattern: /\brafferty'?s?\b/ },
  { canonical: "only organic", pattern: /\bonly\s+organic\b/ },
  { canonical: "heinz", pattern: /\bheinz\b/ },
  { canonical: "farex", pattern: /\bfarex\b/ },
  { canonical: "little bellies", pattern: /\blittle\s+bellies\b/ },
  { canonical: "tamar valley", pattern: /\btamar\s+valley\b/ },
  { canonical: "vaalia", pattern: /\bvaalia\b/ },
  { canonical: "annabel karmel", pattern: /\bannabel\s+karmel\b/ },
  { canonical: "whole kids", pattern: /\bwhole\s+kids\b/ },
  { canonical: "kiddylicious", pattern: /\bkiddylicious\b/ },
  { canonical: "sprout", pattern: /\bsprout\b/ },
  { canonical: "cerelac", pattern: /\bcerelac\b/ },
  { canonical: "mamia", pattern: /\bmamia\b/ },
];

// Distinct product sub-lines that MUST NOT be cross-matched against each other
const KNOWN_VARIANTS: Array<{ canonical: string; pattern: RegExp; specialty?: boolean }> = [
  { canonical: "supremepro", pattern: /\bsupreme\s*pro\b/, specialty: true },
  { canonical: "comfort", pattern: /\bcomfort\b/, specialty: true },
  { canonical: "optipro", pattern: /\bopti\s*pro\b/ },
  { canonical: "profutura", pattern: /\bprofutura\b/, specialty: true },
  { canonical: "allerpro", pattern: /\ballerpro\b/, specialty: true },
  { canonical: "lactose intolerance", pattern: /\b(lactose\s+intoleran\w*|lactose\s+free|delact)\b/, specialty: true },
  { canonical: "sensitive", pattern: /\b(sensitive|gentle\s+care|ar\s+formula|reflux|pepti|hypoallergenic|\bha\b)\b/, specialty: true },
  { canonical: "colic", pattern: /\bcolic\b/, specialty: true },
  { canonical: "essensis", pattern: /\bessensis\b/, specialty: true },
  { canonical: "gentle gold", pattern: /\bgentle\s+gold\b/, specialty: true },
  { canonical: "nappy pants", pattern: /\bnappy\s+pants?\b/, specialty: true },
  { canonical: "swim nappies", pattern: /\b(swim\s+napp|little\s+swimmers)\b/, specialty: true },
  { canonical: "drynites", pattern: /\bdrynites\b/, specialty: true },
  { canonical: "cosifit", pattern: /\bcosifit\b/ },
  { canonical: "ultra dry", pattern: /\bultra\s+dry\b/ },
  { canonical: "skin protect", pattern: /\bskin\s+protect\b/ },
  { canonical: "ultimate", pattern: /\bultimate\b/ },
  { canonical: "pure sensitive", pattern: /\bpure\s*&?\s*sensitive\b/, specialty: true },
  { canonical: "yoghurt melts", pattern: /\byogh?urt\s+melts?\b/ },
  { canonical: "pickup sticks", pattern: /\b(pickup|pick-up)\s+sticks?\b/ },
  { canonical: "round-a-bouts", pattern: /\bround[- ]?a[- ]?bouts?\b/ },
  { canonical: "puffs", pattern: /\bpuffs?\b/ },
  { canonical: "rusks", pattern: /\brusks?\b/ },
];

const SPECIALTY_VARIANTS = new Set(
  KNOWN_VARIANTS.filter((v) => v.specialty).map((v) => v.canonical)
);

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "months", "month", "years", "year",
  "baby", "infant", "toddler", "kids", "child", "pack", "tin", "pouch",
  "premium", "plus", "gold", "food", "milk", "drink", "powder", "formula",
  "suitable", "birth", "nothing", "else", "style", "dairy",
]);

export function parseProductDNA(rawText: string): ProductDNA {
  const lower = rawText
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip per-unit comparison prices (e.g. "$3.89 / 100g", "$0.45 per 1ea", "/ 100ml")
  // before extracting physical pack weight, volume, or count.
  const withoutUnitPrices = lower
    .replace(/\$\s*\d+(?:\.\d+)?\s*(?:\/|per)\s*\d*\s*(?:kg|g|ml|l|ea|each|pack|pk|nappies|wipes)\b/gi, " ")
    .replace(/(?:\/|\bper)\s*(?:100\s*g|100\s*ml|1\s*kg|1\s*l|1\s*ea|1\s*each|100\s*ea)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  let brand: string | null = null;
  for (const b of KNOWN_BRANDS) {
    if (b.pattern.test(lower)) {
      brand = b.canonical;
      break;
    }
  }

  let variant: string | null = null;
  for (const v of KNOWN_VARIANTS) {
    if (v.pattern.test(lower)) {
      variant = v.canonical;
      break;
    }
  }

  const isNappy = /\b(nappy|nappies|swimmers|drynites|pull-ups)\b/.test(lower);
  const isFormula =
    !isNappy &&
    /\b(formula|toddler milk|junior milk|follow-on|follow on|nutritional supplement|junior supplement|milk drink)\b/.test(lower);

  // Extract formula stage (1..4)
  let stage: number | null = null;
  const stageMatch =
    lower.match(/\bstage\s*([1-4])\b/) ??
    lower.match(/\bgold\s+([1-4])\b/) ??
    lower.match(/\bplatinum\s+([1-4])\b/) ??
    lower.match(/\bstep\s*([1-4])\b/);
  if (stageMatch && !isNappy) {
    stage = Number(stageMatch[1]);
  } else if (/\b(newborn|from birth|0\s*[-–to]+\s*6)\b/.test(lower) && isFormula) {
    stage = 1;
  } else if (/\b(follow\s*[- ]?on|6\s*[-–to]+\s*12)\b/.test(lower) && isFormula) {
    stage = 2;
  } else if (/\btoddler\b/.test(lower) && /\bfrom\s*2\b/.test(lower) && isFormula) {
    stage = 4;
  } else if (/\btoddler\b/.test(lower) && isFormula) {
    stage = 3;
  } else if (/\bjunior\b/.test(lower) && isFormula) {
    stage = 4;
  }

  // Extract nappy size (1..6), including AU named sizes (Newborn -> 1 ... Junior -> 6)
  let nappySize: number | null = null;
  const sizeMatch = lower.match(/\bsize\s*([1-6])\b/);
  if (sizeMatch) {
    nappySize = Number(sizeMatch[1]);
  } else if (isNappy) {
    if (/\bnewborn\b/.test(lower)) nappySize = 1;
    else if (/\binfant\b/.test(lower)) nappySize = 2;
    else if (/\bcrawler\b/.test(lower)) nappySize = 3;
    else if (/\btoddler\b/.test(lower)) nappySize = 4;
    else if (/\bwalker\b/.test(lower)) nappySize = 5;
    else if (/\bjunior\b/.test(lower)) nappySize = 6;
  }

  // Extract weight in grams (unit-price-stripped text)
  let grams: number | null = null;
  const kgMatch = withoutUnitPrices.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  const gMatch = withoutUnitPrices.match(/(\d+(?:\.\d+)?)\s*g\b/);
  if (kgMatch) {
    grams = Math.round(Number(kgMatch[1]) * 1000);
  } else if (gMatch) {
    grams = Math.round(Number(gMatch[1]));
  }

  // Extract volume in mL (unit-price-stripped text)
  let ml: number | null = null;
  const mlMatch = withoutUnitPrices.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (mlMatch) ml = Math.round(Number(mlMatch[1]));

  // Extract pack count ("54 pack", "48pk", "200 nappies", "224 nappies")
  let packCount: number | null = null;
  const pkMatch = withoutUnitPrices.match(/(\d+)\s*(?:pack|pk|nappies|ea|sachets?)\b/);
  if (pkMatch) packCount = Number(pkMatch[1]);

  const isSachet =
    /\b(sachet|sachets|travel|single serve|stick pack)\b/.test(lower) ||
    (packCount !== null && packCount <= 10 && isFormula && (grams === null || grams < 300));
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
    variant,
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
 * Returns -1 for hard mismatches (wrong brand, wrong variant/sub-line, wrong formula stage,
 * sachet vs tin, bulk box vs standard pack, wrong nappy size, wrong milk base).
 */
export function matchScore(query: string, candidate: PriceEntry): number {
  const q = parseProductDNA(query);
  const c = parseProductDNA(`${candidate.brand ?? ""} ${candidate.matchedName} ${candidate.unit}`);

  // Hard guard 1: brand must match if query specifies a known brand
  if (q.brand && c.brand !== q.brand) return -1;

  // Hard guard 2: sub-line / variant must match if query specifies one, AND never silently match
  // a specialty/medical/premium variant (e.g. Lactose Intolerance, Profutura, AllerPro, Nappy Pants)
  // when the user searched for the standard base line!
  if (q.variant && c.variant && q.variant !== c.variant) return -1;
  if (q.variant && !c.variant) return -1;
  if (!q.variant && c.variant && SPECIALTY_VARIANTS.has(c.variant)) return -1;

  // Hard guard 3: never match sachets/trial packs when user searched for a standard formula tin
  if (c.isSachet && !q.isSachet) return -1;

  // Hard guard 4: formula stage must match when specified
  if (q.stage !== null && c.stage !== null && q.stage !== c.stage) return -1;
  if (q.stage !== null && c.isFormula && c.stage === null) return -1;

  // Hard guard 5: nappy size must match when specified
  if (q.nappySize !== null && c.nappySize !== null && q.nappySize !== c.nappySize) return -1;

  // Hard guard 6: exclude marketplace bulk cartons (> 120 nappies) unless query asked for bulk
  if (c.isNappy && c.packCount !== null && c.packCount > 120 && !(q.packCount && q.packCount > 120)) {
    return -1;
  }

  // Hard guard 6b: pack count compatibility when query explicitly specifies a pack count
  if (q.packCount && c.packCount) {
    const ratio = Math.min(q.packCount, c.packCount) / Math.max(q.packCount, c.packCount);
    if (ratio < 0.65) return -1;
  }

  // Hard guard 7: goat/soy base must match
  if (q.isGoat !== c.isGoat && (q.isFormula || c.isFormula)) return -1;
  if (q.isSoy !== c.isSoy && (q.isFormula || c.isFormula)) return -1;

  // Hard guard 8: formula should not match non-formula cheap accessories
  if (q.isFormula && !c.isFormula && candidate.price < 12) return -1;

  let score = 0;
  if (q.brand && c.brand === q.brand) score += 35;
  if (q.variant && c.variant === q.variant) score += 25;
  if (q.stage !== null && c.stage === q.stage) score += 25;
  if (q.nappySize !== null && c.nappySize === q.nappySize) score += 25;

  if (q.grams && c.grams) {
    const ratio = Math.min(q.grams, c.grams) / Math.max(q.grams, c.grams);
    if (ratio >= 0.95) score += 20;
    else if (ratio >= 0.8) score += 10;
    else if (ratio < 0.65) return -1;
  }

  let overlap = 0;
  for (const t of q.tokens) {
    if (c.tokens.has(t)) overlap++;
  }
  const tokenRatio = q.tokens.size > 0 ? overlap / q.tokens.size : 0;
  score += Math.round(tokenRatio * 30);

  if (q.isOrganic === c.isOrganic) score += 4;

  const minScore = q.brand ? 35 : 24;
  if (score < minScore) return -1;
  return score;
}

/**
 * Verifies that a Woolworths entry and a Coles entry are genuinely comparable
 * (same brand, same variant/sub-line, same stage/size, compatible pack count).
 */
export function areComparablePair(wow: PriceEntry, coles: PriceEntry): boolean {
  const w = parseProductDNA(`${wow.brand ?? ""} ${wow.matchedName}`);
  const c = parseProductDNA(`${coles.brand ?? ""} ${coles.matchedName}`);

  if (w.brand && c.brand && w.brand !== c.brand) return false;
  if (w.variant && c.variant && w.variant !== c.variant) return false;
  if (w.stage !== null && c.stage !== null && w.stage !== c.stage) return false;
  if (w.nappySize !== null && c.nappySize !== null && w.nappySize !== c.nappySize) return false;
  if (w.isSachet !== c.isSachet) return false;
  if (w.isGoat !== c.isGoat || w.isSoy !== c.isSoy) return false;

  // Reject bulk carton vs normal pack mismatches (pack counts must be within 65% of each other)
  if (w.packCount && c.packCount) {
    const ratio = Math.min(w.packCount, c.packCount) / Math.max(w.packCount, c.packCount);
    if (ratio < 0.65) return false;
  }
  if (w.grams && c.grams) {
    const ratio = Math.min(w.grams, c.grams) / Math.max(w.grams, c.grams);
    if (ratio < 0.70) return false;
  }

  return true;
}

export function computeUnitMetric(entry: PriceEntry): {
  value: number;
  label: string;
} | null {
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
 * Jointly picks the highest-scoring mutually comparable (Woolworths, Coles) pair
 * so e.g. a 44-pack at Woolworths pairs with the exact 44-pack at Coles even when
 * Woolworths also lists a 90-pack jumbo box.
 */
export function pickBestComparablePair(
  query: string,
  wowPool: PriceEntry[],
  colesPool: PriceEntry[]
): { wow: PriceEntry | null; coles: PriceEntry | null } {
  const scoredWow = wowPool
    .map((e) => ({ e, s: matchScore(query, e) }))
    .filter((x) => x.s >= 0);
  const scoredColes = colesPool
    .map((e) => ({ e, s: matchScore(query, e) }))
    .filter((x) => x.s >= 0);

  let bestPair: { wow: PriceEntry; coles: PriceEntry; total: number } | null = null;

  for (const w of scoredWow) {
    for (const c of scoredColes) {
      if (!areComparablePair(w.e, c.e)) continue;
      const exactBonus = classifyPairMatch(w.e, c.e) === "exact" ? 20 : 0;
      const total = w.s + c.s + exactBonus;
      if (!bestPair || total > bestPair.total) {
        bestPair = { wow: w.e, coles: c.e, total };
      }
    }
  }

  if (bestPair) {
    return { wow: bestPair.wow, coles: bestPair.coles };
  }
  return {
    wow: pickBestMatch(query, wowPool),
    coles: pickBestMatch(query, colesPool),
  };
}

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
