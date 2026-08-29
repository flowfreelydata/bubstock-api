import pg from "pg";

const { Pool } = pg;

// Railway injects DATABASE_URL automatically when Postgres is linked to the service.
// Fallback to the external proxy for local dev (set DATABASE_URL in .env).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway.internal")
    ? false                          // internal Railway network — no TLS needed
    : { rejectUnauthorized: false }, // external proxy — TLS without cert verification
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[db] pool error:", err.message);
});

// ─── Schema ──────────────────────────────────────────────────────────────────

export async function initSchema(): Promise<void> {
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
        unit         TEXT,
        is_on_sale   BOOLEAN     DEFAULT FALSE,
        fetched_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_price_lookup
        ON price_entries(lower(product_name), lower(suburb), state, fetched_at DESC);

      CREATE TABLE IF NOT EXISTS recall_entries (
        fsanz_id           TEXT PRIMARY KEY,
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

      CREATE INDEX IF NOT EXISTS idx_recall_product
        ON recall_entries(lower(product_name));
    `);
    console.log("[db] schema ready");
  } finally {
    client.release();
  }
}

// ─── Price helpers ────────────────────────────────────────────────────────────

export interface PriceRow {
  retailer: string;
  store_name: string | null;
  price: number;
  unit: string | null;
  is_on_sale: boolean;
  fetched_at: Date;
}

/** Save a batch of scraped price entries to the database. */
export async function savePrices(
  productName: string,
  suburb: string,
  state: string,
  entries: Array<{ retailer: string; storeName: string; price: number; unit: string; isOnSale: boolean }>
): Promise<void> {
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    for (const e of entries) {
      await client.query(
        `INSERT INTO price_entries
           (product_name, suburb, state, retailer, store_name, price, unit, is_on_sale)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [productName.toLowerCase(), suburb.toLowerCase(), state.toUpperCase(),
         e.retailer, e.storeName, e.price, e.unit, e.isOnSale]
      );
    }
  } catch (err) {
    console.error("[db] savePrices error:", (err as Error).message);
  } finally {
    client.release();
  }
}

/** Returns weekly average prices for the last `weeks` weeks. One point per week per retailer. */
export async function getPriceHistory(
  productName: string,
  suburb: string,
  state: string,
  weeks = 12
): Promise<Array<{ week: string; retailer: string; avg_price: number; min_price: number; max_price: number }>> {
  try {
    const result = await pool.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('week', fetched_at), 'YYYY-MM-DD') AS week,
         retailer,
         ROUND(AVG(price)::NUMERIC, 2)  AS avg_price,
         ROUND(MIN(price)::NUMERIC, 2)  AS min_price,
         ROUND(MAX(price)::NUMERIC, 2)  AS max_price
       FROM price_entries
       WHERE lower(product_name) = lower($1)
         AND lower(suburb)       = lower($2)
         AND state               = upper($3)
         AND fetched_at         >= NOW() - ($4 || ' weeks')::INTERVAL
       GROUP BY DATE_TRUNC('week', fetched_at), retailer
       ORDER BY week ASC, retailer ASC`,
      [productName, suburb, state, weeks]
    );
    return result.rows;
  } catch (err) {
    console.error("[db] getPriceHistory error:", (err as Error).message);
    return [];
  }
}

// ─── Recall helpers ───────────────────────────────────────────────────────────

export interface RecallRow {
  fsanz_id: string;
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

/** Upsert a batch of recalls. Updates last_seen for existing entries. */
export async function upsertRecalls(
  recalls: Array<{
    id: string; productName: string; brand: string; recallDate: string;
    reason: string; affectedAllergens: string[]; affectedBarcodes: string[];
    recallUrl: string; isActive: boolean;
  }>
): Promise<void> {
  if (recalls.length === 0) return;
  const client = await pool.connect();
  try {
    for (const r of recalls) {
      await client.query(
        `INSERT INTO recall_entries
           (fsanz_id, product_name, brand, recall_date, reason,
            affected_allergens, affected_barcodes, recall_url, is_active, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (fsanz_id) DO UPDATE
           SET product_name       = EXCLUDED.product_name,
               brand              = EXCLUDED.brand,
               recall_date        = EXCLUDED.recall_date,
               reason             = EXCLUDED.reason,
               affected_allergens = EXCLUDED.affected_allergens,
               affected_barcodes  = EXCLUDED.affected_barcodes,
               recall_url         = EXCLUDED.recall_url,
               is_active          = EXCLUDED.is_active,
               last_seen          = NOW()`,
        [r.id, r.productName, r.brand, r.recallDate, r.reason,
         r.affectedAllergens, r.affectedBarcodes, r.recallUrl, r.isActive]
      );
    }
  } catch (err) {
    console.error("[db] upsertRecalls error:", (err as Error).message);
  } finally {
    client.release();
  }
}

/** Load all active recalls from the database. */
export async function loadRecalls(): Promise<RecallRow[]> {
  try {
    const result = await pool.query(
      `SELECT * FROM recall_entries WHERE is_active = TRUE ORDER BY last_seen DESC`
    );
    return result.rows;
  } catch (err) {
    console.error("[db] loadRecalls error:", (err as Error).message);
    return [];
  }
}
