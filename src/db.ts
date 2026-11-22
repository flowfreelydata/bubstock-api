import pg from "pg";
import crypto from "node:crypto";
import type {
  PriceEntry,
  PriceGapItem,
  RecallEntry,
  ShelfSighting,
  SpecialEntry,
  StockStateValue,
} from "./types.js";
import { areComparablePair, classifyPairMatch, pickBestComparablePair } from "./matcher.js";

const { Pool } = pg;

const hasDbUrl = Boolean(process.env.DATABASE_URL);

export const pool = hasDbUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes("railway.internal")
        ? false
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

pool?.on("error", (err) => {
  console.error("[db] pool error:", err.message);
});

const memorySightings: ShelfSighting[] = [];
const memorySpecials = new Map<string, SpecialEntry>();

export async function pingDB(): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function initSchema(): Promise<void> {
  if (!pool) {
    console.warn("[db] DATABASE_URL not set — running without PostgreSQL persistence");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS price_entries (
        id           SERIAL PRIMARY KEY,
        product_name TEXT        NOT NULL,
        suburb       TEXT        NOT NULL,
        state        TEXT        NOT NULL DEFAULT 'VIC',
        retailer     TEXT        NOT NULL,
        store_name   TEXT,
        price        NUMERIC(8,2) NOT NULL,
        was_price    NUMERIC(8,2),
        unit         TEXT,
        is_on_sale   BOOLEAN     DEFAULT FALSE,
        is_in_stock  BOOLEAN,
        matched_name TEXT,
        stockcode    TEXT,
        image_url    TEXT,
        product_url  TEXT,
        fetched_at   TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE price_entries ADD COLUMN IF NOT EXISTS was_price    NUMERIC(8,2);
      ALTER TABLE price_entries ADD COLUMN IF NOT EXISTS is_in_stock  BOOLEAN;
      ALTER TABLE price_entries ADD COLUMN IF NOT EXISTS matched_name TEXT;
      ALTER TABLE price_entries ADD COLUMN IF NOT EXISTS stockcode    TEXT;
      ALTER TABLE price_entries ADD COLUMN IF NOT EXISTS image_url    TEXT;
      ALTER TABLE price_entries ADD COLUMN IF NOT EXISTS product_url  TEXT;

      CREATE INDEX IF NOT EXISTS idx_price_lookup
        ON price_entries(lower(product_name), lower(suburb), state, fetched_at DESC);

      CREATE INDEX IF NOT EXISTS idx_price_retailer_recent
        ON price_entries(retailer, lower(product_name), fetched_at DESC);

      CREATE INDEX IF NOT EXISTS idx_price_matched
        ON price_entries(lower(matched_name), fetched_at DESC);

      CREATE TABLE IF NOT EXISTS special_entries (
        id              TEXT PRIMARY KEY,
        retailer        TEXT NOT NULL,
        name            TEXT NOT NULL,
        brand           TEXT,
        category        TEXT NOT NULL,
        price           NUMERIC(8,2) NOT NULL,
        was_price       NUMERIC(8,2) NOT NULL,
        savings_amount  NUMERIC(8,2) NOT NULL,
        savings_percent INT NOT NULL,
        unit            TEXT,
        is_in_stock     BOOLEAN,
        image_url       TEXT,
        product_url     TEXT,
        sale_ends_at    TEXT,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_specials_updated
        ON special_entries(updated_at DESC);

      CREATE TABLE IF NOT EXISTS recall_entries (
        fsanz_id           TEXT PRIMARY KEY,
        agency             TEXT NOT NULL DEFAULT 'FSANZ',
        product_name       TEXT NOT NULL,
        brand              TEXT,
        recall_date        TEXT,
        reason             TEXT,
        affected_allergens TEXT[],
        affected_barcodes  TEXT[],
        recall_url         TEXT,
        is_active          BOOLEAN     DEFAULT TRUE,
        first_seen         TIMESTAMPTZ DEFAULT NOW(),
        last_seen          TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE recall_entries ADD COLUMN IF NOT EXISTS agency TEXT NOT NULL DEFAULT 'FSANZ';

      CREATE INDEX IF NOT EXISTS idx_recall_product
        ON recall_entries(lower(product_name));

      CREATE TABLE IF NOT EXISTS shelf_sightings (
        id             TEXT PRIMARY KEY,
        product_id     TEXT NOT NULL,
        product_name   TEXT,
        store_id       TEXT NOT NULL,
        store_name     TEXT NOT NULL,
        suburb         TEXT NOT NULL,
        retailer       TEXT NOT NULL,
        state          TEXT NOT NULL CHECK (state IN ('onShelf', 'runningLow', 'likelyGone')),
        observed_price NUMERIC(8,2),
        note           TEXT,
        reported_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sightings_product_store
        ON shelf_sightings(product_id, store_id, reported_at DESC);

      CREATE INDEX IF NOT EXISTS idx_sightings_recent
        ON shelf_sightings(reported_at DESC);
    `);
    console.log("[db] schema ready");
  } finally {
    client.release();
  }
}

// ─── Price persistence ───────────────────────────────────────────────────────

export async function savePrices(
  productName: string,
  suburb: string,
  state: string,
  entries: PriceEntry[]
): Promise<void> {
  if (!pool || entries.length === 0) return;
  const client = await pool.connect();
  try {
    for (const e of entries) {
      await client.query(
        `INSERT INTO price_entries
           (product_name, suburb, state, retailer, store_name, price, was_price,
            unit, is_on_sale, is_in_stock, matched_name, stockcode, image_url, product_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          productName.toLowerCase(),
          suburb.toLowerCase(),
          state.toUpperCase(),
          e.retailer,
          e.storeName,
          e.price,
          e.wasPrice ?? null,
          e.unit,
          e.isOnSale,
          e.isInStock ?? null,
          e.matchedName,
          e.stockcode ?? null,
          e.imageUrl ?? null,
          e.productUrl ?? null,
        ]
      );
    }
  } catch (err) {
    console.error("[db] savePrices error:", (err as Error).message);
  } finally {
    client.release();
  }
}

/**
 * Loads fresh verified prices for a retailer (e.g. Coles synced from Melbourne)
 * recorded within the last `maxAgeHours`. Deduplicates by stockcode/matched_name,
 * returning the newest observation per SKU.
 */
export async function getFreshRetailerPrices(
  productQuery: string,
  retailer: string,
  maxAgeHours = 36
): Promise<PriceEntry[]> {
  if (!pool) return [];
  const clean = productQuery.trim().toLowerCase();
  const tokens = clean
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 4);
  if (tokens.length === 0) return [];

  try {
    const tokenClauses = tokens.map(
      (_t, i) => `(lower(product_name) LIKE '%' || $${i + 3} || '%' OR lower(matched_name) LIKE '%' || $${i + 3} || '%')`
    );
    const result = await pool.query(
      `SELECT DISTINCT ON (COALESCE(stockcode, lower(matched_name)))
         retailer, store_name, suburb, state,
         price::FLOAT8 AS price,
         was_price::FLOAT8 AS was_price,
         unit, is_on_sale, is_in_stock, matched_name, stockcode, image_url, product_url, fetched_at
       FROM price_entries
       WHERE retailer = $1
         AND fetched_at >= NOW() - ($2 || ' hours')::INTERVAL
         AND (
           lower(product_name) = lower($3)
           OR (${tokenClauses.join(" AND ")})
         )
       ORDER BY COALESCE(stockcode, lower(matched_name)), fetched_at DESC
       LIMIT 16`,
      [retailer, maxAgeHours, ...tokens]
    );

    return result.rows.map((r) => {
      const was = r.was_price && r.was_price > r.price ? Number(r.was_price) : undefined;
      const savingsPercent = was ? Math.round(((was - r.price) / was) * 100) : undefined;
      return {
        retailer: r.retailer,
        storeName: r.store_name ?? `${r.retailer} VIC`,
        suburb: r.suburb ?? "Melbourne",
        state: r.state ?? "VIC",
        matchedName: r.matched_name ?? productQuery,
        stockcode: r.stockcode ?? undefined,
        price: Number(r.price),
        wasPrice: was,
        savingsPercent,
        currency: "AUD" as const,
        unit: r.unit ?? "",
        isOnSale: Boolean(r.is_on_sale),
        isInStock: typeof r.is_in_stock === "boolean" ? r.is_in_stock : undefined,
        imageUrl: r.image_url ?? undefined,
        productUrl: r.product_url ?? undefined,
        lastUpdated: new Date(r.fetched_at).toISOString(),
      };
    });
  } catch (err) {
    console.error("[db] getFreshRetailerPrices error:", (err as Error).message);
    return [];
  }
}

/**
 * Computes real verified Coles vs Woolworths price gaps across all products
 * observed in both retailers within the last 48 hours.
 */
export async function getColesVsWoolworthsGaps(maxAgeHours = 48): Promise<PriceGapItem[]> {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (lower(product_name), retailer, COALESCE(stockcode, lower(matched_name)))
         lower(product_name) AS product_key,
         retailer,
         price::FLOAT8 AS price,
         was_price::FLOAT8 AS was_price,
         unit, is_on_sale, is_in_stock, matched_name, stockcode, image_url, product_url, fetched_at
       FROM price_entries
       WHERE retailer IN ('Woolworths', 'Coles')
         AND fetched_at >= NOW() - ($1 || ' hours')::INTERVAL
       ORDER BY lower(product_name), retailer, COALESCE(stockcode, lower(matched_name)), fetched_at DESC`,
      [maxAgeHours]
    );

    // Group by product_key
    const grouped = new Map<string, { wow: PriceEntry[]; coles: PriceEntry[] }>();
    for (const r of result.rows) {
      const key = String(r.product_key);
      const bucket = grouped.get(key) ?? { wow: [], coles: [] };
      const entry: PriceEntry = {
        retailer: r.retailer,
        storeName: `${r.retailer} VIC`,
        suburb: "Melbourne",
        state: "VIC",
        matchedName: r.matched_name ?? key,
        stockcode: r.stockcode ?? undefined,
        price: Number(r.price),
        wasPrice: r.was_price && r.was_price > r.price ? Number(r.was_price) : undefined,
        currency: "AUD",
        unit: r.unit ?? "",
        isOnSale: Boolean(r.is_on_sale),
        isInStock: typeof r.is_in_stock === "boolean" ? r.is_in_stock : undefined,
        imageUrl: r.image_url ?? undefined,
        productUrl: r.product_url ?? undefined,
        lastUpdated: new Date(r.fetched_at).toISOString(),
      };
      if (r.retailer === "Woolworths") bucket.wow.push(entry);
      else bucket.coles.push(entry);
      grouped.set(key, bucket);
    }

    const gaps: PriceGapItem[] = [];
    for (const [productKey, { wow, coles }] of grouped) {
      if (wow.length === 0 || coles.length === 0) continue;
      const { wow: bestWow, coles: bestColes } = pickBestComparablePair(productKey, wow, coles);
      if (!bestWow || !bestColes) continue;
      if (!areComparablePair(bestWow, bestColes)) continue;

      const matchQuality = classifyPairMatch(bestWow, bestColes);
      const diff = Number(Math.abs(bestWow.price - bestColes.price).toFixed(2));
      const higher = Math.max(bestWow.price, bestColes.price);
      const pct = higher > 0 ? Math.round((diff / higher) * 100) : 0;
      const cheaperRetailer: "Woolworths" | "Coles" | "Tie" =
        diff < 0.05 ? "Tie" : bestColes.price < bestWow.price ? "Coles" : "Woolworths";

      gaps.push({
        productKey,
        displayName: bestWow.matchedName.length <= bestColes.matchedName.length
          ? bestWow.matchedName
          : bestColes.matchedName,
        matchQuality,
        woolworths: {
          matchedName: bestWow.matchedName,
          price: bestWow.price,
          wasPrice: bestWow.wasPrice,
          unit: bestWow.unit,
          isInStock: bestWow.isInStock,
          imageUrl: bestWow.imageUrl,
          productUrl: bestWow.productUrl,
          lastUpdated: bestWow.lastUpdated,
        },
        coles: {
          matchedName: bestColes.matchedName,
          price: bestColes.price,
          wasPrice: bestColes.wasPrice,
          unit: bestColes.unit,
          isInStock: bestColes.isInStock,
          imageUrl: bestColes.imageUrl,
          productUrl: bestColes.productUrl,
          lastUpdated: bestColes.lastUpdated,
        },
        cheaperRetailer,
        savingsAmount: diff,
        savingsPercent: pct,
      });
    }

    return gaps.sort((a, b) => {
      if (b.savingsAmount !== a.savingsAmount) return b.savingsAmount - a.savingsAmount;
      return b.savingsPercent - a.savingsPercent;
    });
  } catch (err) {
    console.error("[db] getColesVsWoolworthsGaps error:", (err as Error).message);
    return [];
  }
}

export async function getPriceHistory(
  productName: string,
  _suburb: string,
  state: string,
  weeks = 12
): Promise<
  Array<{
    week: string;
    retailer: string;
    avg_price: number;
    min_price: number;
    max_price: number;
  }>
> {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('week', fetched_at), 'YYYY-MM-DD') AS week,
         retailer,
         ROUND(AVG(price)::NUMERIC, 2)::FLOAT8 AS avg_price,
         ROUND(MIN(price)::NUMERIC, 2)::FLOAT8 AS min_price,
         ROUND(MAX(price)::NUMERIC, 2)::FLOAT8 AS max_price
       FROM price_entries
       WHERE (lower(product_name) = lower($1) OR lower(matched_name) LIKE '%' || lower($1) || '%')
         AND state = upper($2)
         AND fetched_at >= NOW() - ($3 || ' weeks')::INTERVAL
       GROUP BY DATE_TRUNC('week', fetched_at), retailer
       ORDER BY week ASC, retailer ASC`,
      [productName, state || "VIC", weeks]
    );
    return result.rows;
  } catch (err) {
    console.error("[db] getPriceHistory error:", (err as Error).message);
    return [];
  }
}

// ─── Specials persistence (merges Woolworths + Coles specials) ───────────────

export async function upsertSpecials(specials: SpecialEntry[]): Promise<void> {
  if (specials.length === 0) return;
  if (!pool) {
    for (const s of specials) memorySpecials.set(s.id, s);
    return;
  }
  const client = await pool.connect();
  try {
    for (const s of specials) {
      await client.query(
        `INSERT INTO special_entries
           (id, retailer, name, brand, category, price, was_price,
            savings_amount, savings_percent, unit, is_in_stock, image_url, product_url, sale_ends_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (id) DO UPDATE
           SET name            = EXCLUDED.name,
               price           = EXCLUDED.price,
               was_price       = EXCLUDED.was_price,
               savings_amount  = EXCLUDED.savings_amount,
               savings_percent = EXCLUDED.savings_percent,
               unit            = EXCLUDED.unit,
               is_in_stock     = EXCLUDED.is_in_stock,
               image_url       = EXCLUDED.image_url,
               product_url     = EXCLUDED.product_url,
               updated_at      = NOW()`,
        [
          s.id,
          s.retailer,
          s.name,
          s.brand ?? null,
          s.category,
          s.price,
          s.wasPrice,
          s.savingsAmount,
          s.savingsPercent,
          s.unit,
          s.isInStock ?? null,
          s.imageUrl ?? null,
          s.productUrl ?? null,
          s.saleEndsAt ?? null,
        ]
      );
    }
  } catch (err) {
    console.error("[db] upsertSpecials error:", (err as Error).message);
  } finally {
    client.release();
  }
}

export async function loadFreshSpecials(maxAgeHours = 36): Promise<SpecialEntry[]> {
  if (!pool) {
    return [...memorySpecials.values()];
  }
  try {
    const result = await pool.query(
      `SELECT id, retailer, name, brand, category,
              price::FLOAT8 AS price,
              was_price::FLOAT8 AS was_price,
              savings_amount::FLOAT8 AS savings_amount,
              savings_percent, unit, is_in_stock, image_url, product_url, sale_ends_at, updated_at
       FROM special_entries
       WHERE updated_at >= NOW() - ($1 || ' hours')::INTERVAL
       ORDER BY savings_percent DESC, savings_amount DESC
       LIMIT 200`,
      [maxAgeHours]
    );
    return result.rows.map((r) => ({
      id: r.id,
      retailer: r.retailer,
      name: r.name,
      brand: r.brand ?? undefined,
      category: r.category,
      price: Number(r.price),
      wasPrice: Number(r.was_price),
      savingsAmount: Number(r.savings_amount),
      savingsPercent: Number(r.savings_percent),
      unit: r.unit ?? "",
      isInStock: typeof r.is_in_stock === "boolean" ? r.is_in_stock : undefined,
      imageUrl: r.image_url ?? undefined,
      productUrl: r.product_url ?? undefined,
      saleEndsAt: r.sale_ends_at ?? undefined,
      lastUpdated: new Date(r.updated_at).toISOString(),
    }));
  } catch (err) {
    console.error("[db] loadFreshSpecials error:", (err as Error).message);
    return [];
  }
}

// ─── Recalls persistence ─────────────────────────────────────────────────────

export interface RecallRow {
  fsanz_id: string;
  agency: "FSANZ" | "ACCC";
  product_name: string;
  brand: string;
  recall_date: string;
  reason: string;
  affected_allergens: string[];
  affected_barcodes: string[];
  recall_url: string;
  is_active: boolean;
  last_seen: Date;
}

export async function upsertRecalls(recalls: RecallEntry[]): Promise<void> {
  if (!pool || recalls.length === 0) return;
  const client = await pool.connect();
  try {
    for (const r of recalls) {
      await client.query(
        `INSERT INTO recall_entries
           (fsanz_id, agency, product_name, brand, recall_date, reason,
            affected_allergens, affected_barcodes, recall_url, is_active, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (fsanz_id) DO UPDATE
           SET agency             = EXCLUDED.agency,
               product_name       = EXCLUDED.product_name,
               brand              = EXCLUDED.brand,
               recall_date        = EXCLUDED.recall_date,
               reason             = EXCLUDED.reason,
               affected_allergens = EXCLUDED.affected_allergens,
               affected_barcodes  = EXCLUDED.affected_barcodes,
               recall_url         = EXCLUDED.recall_url,
               is_active          = EXCLUDED.is_active,
               last_seen          = NOW()`,
        [
          r.id,
          r.agency,
          r.productName,
          r.brand,
          r.recallDate,
          r.reason,
          r.affectedAllergens,
          r.affectedBarcodes,
          r.recallUrl,
          r.isActive,
        ]
      );
    }
  } catch (err) {
    console.error("[db] upsertRecalls error:", (err as Error).message);
  } finally {
    client.release();
  }
}

export async function loadRecalls(): Promise<RecallRow[]> {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM recall_entries WHERE is_active = TRUE ORDER BY last_seen DESC LIMIT 100`
    );
    return result.rows;
  } catch (err) {
    console.error("[db] loadRecalls error:", (err as Error).message);
    return [];
  }
}

// ─── Real Melbourne Shelf Sightings ──────────────────────────────────────────

export interface NewSightingInput {
  productId: string;
  productName?: string;
  storeId: string;
  storeName: string;
  suburb: string;
  retailer: string;
  state: StockStateValue;
  observedPrice?: number;
  note?: string;
}

export async function saveSighting(input: NewSightingInput): Promise<ShelfSighting> {
  const id = crypto.randomUUID();
  const reportedAt = new Date().toISOString();
  const sighting: ShelfSighting = {
    id,
    productId: input.productId,
    productName: input.productName,
    storeId: input.storeId,
    storeName: input.storeName,
    suburb: input.suburb,
    retailer: input.retailer,
    state: input.state,
    observedPrice: input.observedPrice,
    note: input.note,
    reportedAt,
  };

  if (!pool) {
    memorySightings.unshift(sighting);
    if (memorySightings.length > 1000) memorySightings.pop();
    return sighting;
  }

  await pool.query(
    `INSERT INTO shelf_sightings
       (id, product_id, product_name, store_id, store_name, suburb, retailer, state, observed_price, note, reported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      sighting.id,
      sighting.productId,
      sighting.productName ?? null,
      sighting.storeId,
      sighting.storeName,
      sighting.suburb,
      sighting.retailer,
      sighting.state,
      sighting.observedPrice ?? null,
      sighting.note ?? null,
      sighting.reportedAt,
    ]
  );

  return sighting;
}

export async function getSightings(opts: {
  productId?: string;
  storeId?: string;
  hours?: number;
  limit?: number;
}): Promise<ShelfSighting[]> {
  const hours = Math.min(Math.max(opts.hours ?? 72, 1), 168);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 250);

  if (!pool) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    return memorySightings
      .filter((s) => new Date(s.reportedAt).getTime() >= cutoff)
      .filter((s) => !opts.productId || s.productId === opts.productId)
      .filter((s) => !opts.storeId || s.storeId === opts.storeId)
      .slice(0, limit);
  }

  const conditions = [`reported_at >= NOW() - ($1 || ' hours')::INTERVAL`];
  const params: Array<string | number> = [hours];

  if (opts.productId) {
    params.push(opts.productId);
    conditions.push(`product_id = $${params.length}`);
  }
  if (opts.storeId) {
    params.push(opts.storeId);
    conditions.push(`store_id = $${params.length}`);
  }
  params.push(limit);

  const result = await pool.query(
    `SELECT id, product_id, product_name, store_id, store_name, suburb, retailer,
            state, observed_price::FLOAT8 AS observed_price, note, reported_at
     FROM shelf_sightings
     WHERE ${conditions.join(" AND ")}
     ORDER BY reported_at DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    productName: r.product_name ?? undefined,
    storeId: r.store_id,
    storeName: r.store_name,
    suburb: r.suburb,
    retailer: r.retailer,
    state: r.state as StockStateValue,
    observedPrice: r.observed_price ?? undefined,
    note: r.note ?? undefined,
    reportedAt: new Date(r.reported_at).toISOString(),
  }));
}

export async function countRecentSightings(hours = 24): Promise<number> {
  if (!pool) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    return memorySightings.filter((s) => new Date(s.reportedAt).getTime() >= cutoff).length;
  }
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::INT AS cnt FROM shelf_sightings WHERE reported_at >= NOW() - ($1 || ' hours')::INTERVAL`,
      [hours]
    );
    return r.rows[0]?.cnt ?? 0;
  } catch {
    return 0;
  }
}
