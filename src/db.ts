import pg from "pg";
import crypto from "node:crypto";
import type { PriceEntry, RecallEntry, ShelfSighting, StockStateValue } from "./types.js";

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

// In-memory store ONLY used when running without DATABASE_URL (local dev).
// On Railway, PostgreSQL is the single source of truth.
const memorySightings: ShelfSighting[] = [];

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

      CREATE INDEX IF NOT EXISTS idx_price_matched
        ON price_entries(lower(matched_name), fetched_at DESC);

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

export async function getPriceHistory(
  productName: string,
  suburb: string,
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
    // Match across VIC (Melbourne-wide prices are uniform per retailer chain)
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
      .filter((s) => (!opts.productId || s.productId === opts.productId))
      .filter((s) => (!opts.storeId || s.storeId === opts.storeId))
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
