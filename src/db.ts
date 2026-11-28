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
        : { rejectUnauthorized: process.env.PG_SSL_ALLOW_SELF_SIGNED !== "true" },
      max: 6,
      idleTimeoutMillis: 20_000,
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
        device_hash    TEXT,
        reported_at    TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE shelf_sightings ADD COLUMN IF NOT EXISTS device_hash TEXT;
      ALTER TABLE shelf_sightings ADD COLUMN IF NOT EXISTS is_shadow_banned BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE INDEX IF NOT EXISTS idx_sightings_product_store
        ON shelf_sightings(product_id, store_id, reported_at DESC);

      CREATE INDEX IF NOT EXISTS idx_sightings_recent
        ON shelf_sightings(reported_at DESC);

      CREATE INDEX IF NOT EXISTS idx_sightings_visible
        ON shelf_sightings(is_shadow_banned, reported_at DESC);

      CREATE TABLE IF NOT EXISTS social_promos (
        id            TEXT PRIMARY KEY,
        platform      TEXT NOT NULL,
        post_url      TEXT NOT NULL UNIQUE,
        referral_code TEXT,
        city          TEXT,
        device_hash   TEXT,
        submitted_at  TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE social_promos ADD COLUMN IF NOT EXISTS device_hash TEXT;

      CREATE INDEX IF NOT EXISTS idx_social_promos_recent
        ON social_promos(submitted_at DESC);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        device_id            TEXT PRIMARY KEY,
        owner_key_id         TEXT,
        apns_token           TEXT,
        city                 TEXT NOT NULL DEFAULT 'melbourne',
        state                TEXT NOT NULL DEFAULT 'VIC',
        has_plus             BOOLEAN NOT NULL DEFAULT FALSE,
        half_price_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
        min_discount_percent INT NOT NULL DEFAULT 40,
        alert_categories     TEXT[] NOT NULL DEFAULT ARRAY['nappies','formula'],
        watched_rules        JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at           TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS owner_key_id TEXT;

      CREATE TABLE IF NOT EXISTS sent_push_alerts (
        device_id  TEXT NOT NULL,
        alert_key  TEXT NOT NULL,
        sent_at    TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (device_id, alert_key)
      );

      CREATE INDEX IF NOT EXISTS idx_sent_push_recent
        ON sent_push_alerts(sent_at DESC);

      CREATE TABLE IF NOT EXISTS household_vaults (
        vault_id        TEXT PRIMARY KEY,
        write_token_hash TEXT,
        ciphertext      TEXT NOT NULL,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE household_vaults ADD COLUMN IF NOT EXISTS write_token_hash TEXT;

      CREATE TABLE IF NOT EXISTS mothers_groups (
        group_code      TEXT PRIMARY KEY,
        suburb          TEXT NOT NULL,
        city            TEXT NOT NULL,
        member_hashes   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        member_ip_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE mothers_groups ADD COLUMN IF NOT EXISTS member_ip_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

      CREATE TABLE IF NOT EXISTS referral_codes (
        code              TEXT PRIMARY KEY,
        owner_device_hash TEXT NOT NULL,
        redeemer_hashes   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS device_promo_claims (
        device_hash TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        claimed_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS attested_keys (
        key_id            TEXT PRIMARY KEY,
        public_key_pem    TEXT NOT NULL,
        attest_mode       TEXT NOT NULL DEFAULT 'secure_enclave',
        app_attest_cbor   TEXT,
        bundle_id         TEXT NOT NULL DEFAULT 'au.com.bubstock.app',
        last_counter      BIGINT NOT NULL DEFAULT 0,
        taint_mask        INT NOT NULL DEFAULT 0,
        enrolled_ip_hash  TEXT,
        enrolled_at       TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hostile_fingerprints (
        ip_hash       TEXT PRIMARY KEY,
        threat_score  INT NOT NULL DEFAULT 100,
        reason        TEXT NOT NULL,
        hit_count     INT NOT NULL DEFAULT 1,
        first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
      );

      CREATE TABLE IF NOT EXISTS honeypot_hits (
        id          SERIAL PRIMARY KEY,
        ip_hash     TEXT NOT NULL,
        path        TEXT NOT NULL,
        method      TEXT NOT NULL,
        user_agent  TEXT,
        reason      TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_honeypot_hits_recent
        ON honeypot_hits(created_at DESC);

      CREATE TABLE IF NOT EXISTS shadow_banned_devices (
        device_hash TEXT PRIMARY KEY,
        strikes     INT NOT NULL DEFAULT 1,
        is_banned   BOOLEAN NOT NULL DEFAULT FALSE,
        reason      TEXT NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
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
         retailer, suburb, state,
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
      const st = String(r.state ?? "VIC").toUpperCase();
      const entry: PriceEntry = {
        retailer: r.retailer,
        storeName: `${r.retailer} ${st}`,
        suburb: String(r.suburb ?? "Melbourne"),
        state: st,
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

// ─── Statistical Median Reference (Anti-Poisoning Guard) ─────────────────────

export async function getMedianProductPrice(
  productName: string
): Promise<{ median: number; sampleCount: number } | null> {
  if (!pool) return null;
  const clean = productName.trim().toLowerCase();
  const tokens = clean
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !["baby", "food", "pack", "tin", "box", "each", "from"].includes(t))
    .slice(0, 4);
  if (tokens.length === 0) return null;

  try {
    const tokenClauses = tokens.map(
      (_t, i) => `(lower(product_name) LIKE '%' || $${i + 2} || '%' OR lower(matched_name) LIKE '%' || $${i + 2} || '%')`
    );
    const res = await pool.query(
      `SELECT
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)::FLOAT8 AS median,
         COUNT(*)::INT AS cnt
       FROM price_entries
       WHERE fetched_at >= NOW() - INTERVAL '90 days'
         AND price > 0.5
         AND (
           lower(product_name) = lower($1)
           OR (${tokenClauses.join(" AND ")})
         )`,
      [clean, ...tokens]
    );
    const row = res.rows[0];
    if (row && Number.isFinite(row.median) && row.median > 0 && row.cnt >= 1) {
      return { median: Number(row.median.toFixed(2)), sampleCount: Number(row.cnt) };
    }

    // Fallback to live special_entries if product hasn't been searched individually yet
    const spClauses = tokens.map((_t, i) => `lower(name) LIKE '%' || $${i + 1} || '%'`);
    const spRes = await pool.query(
      `SELECT
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY was_price)::FLOAT8 AS median,
         COUNT(*)::INT AS cnt
       FROM special_entries
       WHERE ${spClauses.join(" AND ")}`,
      tokens
    );
    const spRow = spRes.rows[0];
    if (spRow && Number.isFinite(spRow.median) && spRow.median > 0 && spRow.cnt >= 1) {
      return { median: Number(spRow.median.toFixed(2)), sampleCount: Number(spRow.cnt) };
    }
    return null;
  } catch (err) {
    console.error("[db] getMedianProductPrice error:", (err as Error).message);
    return null;
  }
}

// ─── Real Community Shelf Sightings & Corroboration Trust Engine ─────────────

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
  deviceId?: string;
  isShadowBanned?: boolean;
}

export function hashDeviceId(deviceId?: string): string | undefined {
  if (!deviceId || deviceId.trim().length < 4) return undefined;
  return crypto.createHash("sha256").update(`bubstock-trust-v1:${deviceId.trim()}`).digest("hex").slice(0, 16);
}

interface InternalMemorySighting extends ShelfSighting {
  deviceHash?: string;
  isShadowBanned?: boolean;
}
const memorySightingsWithHash: InternalMemorySighting[] = memorySightings;

export async function saveSighting(input: NewSightingInput): Promise<ShelfSighting> {
  const id = crypto.randomUUID();
  const reportedAt = new Date().toISOString();
  const deviceHash = hashDeviceId(input.deviceId);
  const shadow = Boolean(input.isShadowBanned);
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
    corroborationCount: 1,
    verifiedByCommunity: false,
    reportedAt,
  };

  if (!pool) {
    memorySightingsWithHash.unshift({ ...sighting, deviceHash, isShadowBanned: shadow });
    if (memorySightingsWithHash.length > 1000) memorySightingsWithHash.pop();
    const cutoff = Date.now() - 12 * 3600 * 1000;
    const reporters = new Set(
      memorySightingsWithHash
        .filter(
          (s) =>
            (!s.isShadowBanned || (shadow && s.deviceHash === deviceHash)) &&
            s.productId === sighting.productId &&
            s.storeId === sighting.storeId &&
            s.state === sighting.state &&
            new Date(s.reportedAt).getTime() >= cutoff
        )
        .map((s) => s.deviceHash ?? s.id)
    );
    sighting.corroborationCount = Math.max(1, reporters.size);
    sighting.verifiedByCommunity = sighting.corroborationCount >= 2;
    return sighting;
  }

  await pool.query(
    `INSERT INTO shelf_sightings
       (id, product_id, product_name, store_id, store_name, suburb, retailer, state, observed_price, note, device_hash, is_shadow_banned, reported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
      deviceHash ?? null,
      shadow,
      sighting.reportedAt,
    ]
  );

  // Count distinct non-shadow-banned local parents agreeing on this product/store/state within 12 hours
  const corr = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE(device_hash, id))::INT AS cnt
     FROM shelf_sightings
     WHERE product_id = $1
       AND store_id = $2
       AND state = $3
       AND is_shadow_banned = FALSE
       AND reported_at >= NOW() - INTERVAL '12 hours'`,
    [sighting.productId, sighting.storeId, sighting.state]
  );
  const count = Math.max(1, Number(corr.rows[0]?.cnt ?? 1));
  sighting.corroborationCount = count;
  sighting.verifiedByCommunity = !shadow && count >= 2;

  return sighting;
}

export async function getSightings(opts: {
  productId?: string;
  storeId?: string;
  hours?: number;
  limit?: number;
  viewerDeviceId?: string;
}): Promise<ShelfSighting[]> {
  const hours = Math.min(Math.max(opts.hours ?? 72, 1), 168);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 250);
  const viewerHash = hashDeviceId(opts.viewerDeviceId);

  if (!pool) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const corrCutoff = Date.now() - 12 * 3600 * 1000;
    const filtered = memorySightingsWithHash
      .filter((s) => new Date(s.reportedAt).getTime() >= cutoff)
      .filter((s) => !s.isShadowBanned || (viewerHash !== undefined && s.deviceHash === viewerHash))
      .filter((s) => !opts.productId || s.productId === opts.productId)
      .filter((s) => !opts.storeId || s.storeId === opts.storeId)
      .slice(0, limit);

    const groups = new Map<string, Set<string>>();
    for (const s of filtered) {
      if (!s.isShadowBanned && new Date(s.reportedAt).getTime() >= corrCutoff) {
        const k = `${s.productId}|${s.storeId}|${s.state}`;
        const set = groups.get(k) ?? new Set<string>();
        set.add(s.deviceHash ?? s.id);
        groups.set(k, set);
      }
    }
    return filtered.map((s) => {
      const k = `${s.productId}|${s.storeId}|${s.state}`;
      const count = Math.max(1, groups.get(k)?.size ?? 1);
      return {
        id: s.id,
        productId: s.productId,
        productName: s.productName,
        storeId: s.storeId,
        storeName: s.storeName,
        suburb: s.suburb,
        retailer: s.retailer,
        state: s.state,
        observedPrice: s.observedPrice,
        note: s.note,
        corroborationCount: count,
        verifiedByCommunity: !s.isShadowBanned && count >= 2,
        reportedAt: s.reportedAt,
      };
    });
  }

  const conditions = [`reported_at >= NOW() - ($1 || ' hours')::INTERVAL`];
  const params: Array<string | number> = [hours];

  if (viewerHash) {
    // Shadow-banned saboteurs see their own fake reports (mirage!), while real parents NEVER see them.
    params.push(viewerHash);
    conditions.push(`(is_shadow_banned = FALSE OR device_hash = $${params.length})`);
  } else {
    conditions.push(`is_shadow_banned = FALSE`);
  }

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
            state, observed_price::FLOAT8 AS observed_price, note, device_hash, is_shadow_banned, reported_at
     FROM shelf_sightings
     WHERE ${conditions.join(" AND ")}
     ORDER BY reported_at DESC
     LIMIT $${params.length}`,
    params
  );

  // Compute real distinct-parent corroboration within the last 12 hours (excluding shadow-banned rows)
  const corrCutoffMs = Date.now() - 12 * 3600 * 1000;
  const groups = new Map<string, Set<string>>();
  for (const r of result.rows) {
    if (r.is_shadow_banned) continue;
    const ts = new Date(r.reported_at).getTime();
    if (ts >= corrCutoffMs) {
      const k = `${r.product_id}|${r.store_id}|${r.state}`;
      const set = groups.get(k) ?? new Set<string>();
      set.add(r.device_hash ?? r.id);
      groups.set(k, set);
    }
  }

  return result.rows.map((r) => {
    const k = `${r.product_id}|${r.store_id}|${r.state}`;
    const count = Math.max(1, groups.get(k)?.size ?? 1);
    return {
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
      corroborationCount: count,
      verifiedByCommunity: !r.is_shadow_banned && count >= 2,
      reportedAt: new Date(r.reported_at).toISOString(),
    };
  });
}

export async function countRecentSightings(hours = 24): Promise<number> {
  if (!pool) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    return memorySightingsWithHash.filter(
      (s) => !s.isShadowBanned && new Date(s.reportedAt).getTime() >= cutoff
    ).length;
  }
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::INT AS cnt
       FROM shelf_sightings
       WHERE is_shadow_banned = FALSE
         AND reported_at >= NOW() - ($1 || ' hours')::INTERVAL`,
      [hours]
    );
    return r.rows[0]?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ─── Social Shoutout Promos (2 Months Free Growth Loop) ──────────────────────

export interface SocialPromoRecord {
  id: string;
  platform: string;
  postUrl: string;
  referralCode?: string;
  city?: string;
  submittedAt: string;
}

const memoryPromos: SocialPromoRecord[] = [];

export async function saveSocialPromo(input: {
  platform: string;
  postUrl: string;
  referralCode?: string;
  city?: string;
  deviceId?: string;
}): Promise<{ duplicate: boolean; alreadyClaimedByDevice?: boolean; record?: SocialPromoRecord }> {
  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const devHash = hashDeviceId(input.deviceId);
  const record: SocialPromoRecord = { id, platform: input.platform, postUrl: input.postUrl, referralCode: input.referralCode, city: input.city, submittedAt };

  if (!pool) {
    if (memoryPromos.some((p) => p.postUrl.toLowerCase() === input.postUrl.toLowerCase())) {
      return { duplicate: true };
    }
    memoryPromos.unshift(record);
    return { duplicate: false, record };
  }

  if (devHash) {
    const existing = await pool.query(
      `SELECT 1 FROM social_promos WHERE device_hash = $1 LIMIT 1`,
      [devHash]
    );
    if ((existing.rowCount ?? 0) > 0) {
      return { duplicate: true, alreadyClaimedByDevice: true };
    }
  }

  const res = await pool.query(
    `INSERT INTO social_promos (id, platform, post_url, referral_code, city, device_hash, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (post_url) DO NOTHING
     RETURNING id`,
    [id, input.platform, input.postUrl, input.referralCode ?? null, input.city ?? null, devHash ?? null, submittedAt]
  );

  if (res.rowCount === 0) {
    return { duplicate: true };
  }

  if (devHash) {
    await pool.query(
      `INSERT INTO device_promo_claims (device_hash, kind) VALUES ($1, 'social') ON CONFLICT (device_hash) DO NOTHING`,
      [devHash]
    ).catch(() => {});
  }
  return { duplicate: false, record };
}

export async function getRecentSocialPromos(limit = 50): Promise<SocialPromoRecord[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  if (!pool) return memoryPromos.slice(0, capped);
  try {
    const r = await pool.query(
      `SELECT id, platform, post_url, referral_code, city, submitted_at
       FROM social_promos
       ORDER BY submitted_at DESC
       LIMIT $1`,
      [capped]
    );
    return r.rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      postUrl: row.post_url,
      referralCode: row.referral_code ?? undefined,
      city: row.city ?? undefined,
      submittedAt: new Date(row.submitted_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

// ─── Push Notification Alert Subscriptions (APNs + Background Check) ─────────

export interface WatchedAlertRule {
  productId: string;
  name: string;
  targetPrice?: number;
}

export interface PushSubscriptionRecord {
  deviceId: string;
  ownerKeyId?: string;
  apnsToken?: string;
  city: string;
  state: string;
  hasPlus: boolean;
  halfPriceEnabled: boolean;
  minDiscountPercent: number;
  alertCategories: string[];
  watchedRules: WatchedAlertRule[];
  updatedAt: string;
}

const memoryPushSubs = new Map<string, PushSubscriptionRecord>();
const memorySentKeys = new Set<string>();

export async function upsertPushSubscription(
  sub: Omit<PushSubscriptionRecord, "updatedAt">
): Promise<{ ok: boolean; forbidden?: boolean }> {
  const updatedAt = new Date().toISOString();

  if (!pool) {
    const existing = memoryPushSubs.get(sub.deviceId);
    if (existing?.ownerKeyId && sub.ownerKeyId && existing.ownerKeyId !== sub.ownerKeyId) {
      return { ok: false, forbidden: true };
    }
    const full: PushSubscriptionRecord = {
      ...sub,
      ownerKeyId: existing?.ownerKeyId ?? sub.ownerKeyId,
      updatedAt,
    };
    memoryPushSubs.set(sub.deviceId, full);
    return { ok: true };
  }

  const existing = await pool.query(
    `SELECT owner_key_id FROM push_subscriptions WHERE device_id = $1`,
    [sub.deviceId]
  );
  const storedOwner = existing.rows[0]?.owner_key_id ? String(existing.rows[0].owner_key_id) : undefined;
  if (storedOwner && sub.ownerKeyId && storedOwner !== sub.ownerKeyId) {
    return { ok: false, forbidden: true };
  }

  await pool.query(
    `INSERT INTO push_subscriptions
       (device_id, owner_key_id, apns_token, city, state, has_plus, half_price_enabled, min_discount_percent, alert_categories, watched_rules, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     ON CONFLICT (device_id) DO UPDATE SET
       owner_key_id         = COALESCE(push_subscriptions.owner_key_id, EXCLUDED.owner_key_id),
       apns_token           = COALESCE(EXCLUDED.apns_token, push_subscriptions.apns_token),
       city                 = EXCLUDED.city,
       state                = EXCLUDED.state,
       has_plus             = EXCLUDED.has_plus,
       half_price_enabled   = EXCLUDED.half_price_enabled,
       min_discount_percent = EXCLUDED.min_discount_percent,
       alert_categories     = EXCLUDED.alert_categories,
       watched_rules        = EXCLUDED.watched_rules,
       updated_at           = EXCLUDED.updated_at`,
    [
      sub.deviceId,
      sub.ownerKeyId ?? null,
      sub.apnsToken ?? null,
      sub.city,
      sub.state,
      sub.hasPlus,
      sub.halfPriceEnabled,
      sub.minDiscountPercent,
      sub.alertCategories,
      JSON.stringify(sub.watchedRules),
      updatedAt,
    ]
  );
  return { ok: true };
}

export async function getPushSubscription(deviceId: string): Promise<PushSubscriptionRecord | null> {
  if (!pool) return memoryPushSubs.get(deviceId) ?? null;
  const r = await pool.query(
    `SELECT device_id, owner_key_id, apns_token, city, state, has_plus, half_price_enabled,
            min_discount_percent, alert_categories, watched_rules, updated_at
     FROM push_subscriptions WHERE device_id = $1`,
    [deviceId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    deviceId: row.device_id,
    ownerKeyId: row.owner_key_id ?? undefined,
    apnsToken: row.apns_token ?? undefined,
    city: row.city,
    state: row.state,
    hasPlus: Boolean(row.has_plus),
    halfPriceEnabled: Boolean(row.half_price_enabled),
    minDiscountPercent: Number(row.min_discount_percent ?? 40),
    alertCategories: Array.isArray(row.alert_categories) ? row.alert_categories : ["nappies", "formula"],
    watchedRules: Array.isArray(row.watched_rules) ? row.watched_rules : [],
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listActiveApnsSubscriptions(): Promise<PushSubscriptionRecord[]> {
  if (!pool) {
    return [...memoryPushSubs.values()].filter((s) => Boolean(s.apnsToken));
  }
  const r = await pool.query(
    `SELECT device_id, apns_token, city, state, has_plus, half_price_enabled,
            min_discount_percent, alert_categories, watched_rules, updated_at
     FROM push_subscriptions
     WHERE apns_token IS NOT NULL AND length(apns_token) >= 32`
  );
  return r.rows.map((row) => ({
    deviceId: row.device_id,
    apnsToken: row.apns_token ?? undefined,
    city: row.city,
    state: row.state,
    hasPlus: Boolean(row.has_plus),
    halfPriceEnabled: Boolean(row.half_price_enabled),
    minDiscountPercent: Number(row.min_discount_percent ?? 40),
    alertCategories: Array.isArray(row.alert_categories) ? row.alert_categories : ["nappies", "formula"],
    watchedRules: Array.isArray(row.watched_rules) ? row.watched_rules : [],
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function markPushAlertSentIfNew(deviceId: string, alertKey: string): Promise<boolean> {
  if (!pool) {
    const k = `${deviceId}|${alertKey}`;
    if (memorySentKeys.has(k)) return false;
    memorySentKeys.add(k);
    return true;
  }
  const res = await pool.query(
    `INSERT INTO sent_push_alerts (device_id, alert_key)
     VALUES ($1, $2)
     ON CONFLICT (device_id, alert_key) DO NOTHING
     RETURNING alert_key`,
    [deviceId, alertKey]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function clearInvalidApnsToken(deviceId: string): Promise<void> {
  if (!pool) {
    const existing = memoryPushSubs.get(deviceId);
    if (existing) existing.apnsToken = undefined;
    return;
  }
  await pool.query(`UPDATE push_subscriptions SET apns_token = NULL WHERE device_id = $1`, [deviceId]);
}

// ─── Zero-Knowledge E2EE Two-Parent Household Vault (Write-Proof Protected) ──

const memoryVaults = new Map<string, { ciphertext: string; writeTokenHash: string; updatedAt: string }>();

function hashSecretToken(token: string): string {
  return crypto.createHash("sha256").update(`bubstock-vault-write-v1:${token}`).digest("hex");
}

function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function upsertHouseholdVault(
  vaultId: string,
  writeToken: string,
  ciphertext: string
): Promise<{ ok: boolean; forbidden?: boolean; storageFull?: boolean; updatedAt?: string }> {
  const tokenHash = hashSecretToken(writeToken);
  const updatedAt = new Date().toISOString();

  if (!pool) {
    const existing = memoryVaults.get(vaultId);
    if (existing && !safeHexEqual(existing.writeTokenHash, tokenHash)) {
      return { ok: false, forbidden: true };
    }
    if (!existing && memoryVaults.size >= 5000) {
      return { ok: false, storageFull: true };
    }
    memoryVaults.set(vaultId, { ciphertext, writeTokenHash: tokenHash, updatedAt });
    return { ok: true, updatedAt };
  }

  const existing = await pool.query(
    `SELECT write_token_hash FROM household_vaults WHERE vault_id = $1`,
    [vaultId]
  );

  if (existing.rows.length > 0) {
    const storedHash = String(existing.rows[0].write_token_hash ?? "");
    if (storedHash && !safeHexEqual(storedHash, tokenHash)) {
      return { ok: false, forbidden: true };
    }
    await pool.query(
      `UPDATE household_vaults
       SET ciphertext = $2, write_token_hash = COALESCE(write_token_hash, $3), updated_at = NOW()
       WHERE vault_id = $1`,
      [vaultId, ciphertext, tokenHash]
    );
    return { ok: true, updatedAt };
  }

  // Prune abandoned vaults (>180 days untouched) & enforce storage safety ceiling
  await pool.query(`DELETE FROM household_vaults WHERE updated_at < NOW() - INTERVAL '180 days'`).catch(() => {});
  const cntRes = await pool.query(`SELECT COUNT(*)::INT AS cnt FROM household_vaults`);
  if ((cntRes.rows[0]?.cnt ?? 0) >= 50_000) {
    return { ok: false, storageFull: true };
  }

  await pool.query(
    `INSERT INTO household_vaults (vault_id, write_token_hash, ciphertext, updated_at)
     VALUES ($1, $2, $3, NOW())`,
    [vaultId, tokenHash, ciphertext]
  );
  return { ok: true, updatedAt };
}

export async function getHouseholdVault(vaultId: string): Promise<{ ciphertext: string; updatedAt: string } | null> {
  if (!pool) {
    const v = memoryVaults.get(vaultId);
    return v ? { ciphertext: v.ciphertext, updatedAt: v.updatedAt } : null;
  }
  const r = await pool.query(
    `SELECT ciphertext, updated_at FROM household_vaults WHERE vault_id = $1`,
    [vaultId]
  );
  if (r.rows.length === 0) return null;
  return {
    ciphertext: String(r.rows[0].ciphertext),
    updatedAt: new Date(r.rows[0].updated_at).toISOString(),
  };
}

// ─── Server-Verified Referral Codes & Entitlement Proofs ─────────────────────

const memoryReferrals = new Map<string, { ownerHash: string; redeemers: Set<string> }>();
const memoryDeviceClaims = new Set<string>();

export async function registerReferralCode(code: string, deviceId: string): Promise<void> {
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ownerHash = hashDeviceId(deviceId);
  if (cleanCode.length !== 6 || !ownerHash) return;

  if (!pool) {
    if (!memoryReferrals.has(cleanCode)) {
      memoryReferrals.set(cleanCode, { ownerHash, redeemers: new Set() });
    }
    return;
  }

  await pool.query(
    `INSERT INTO referral_codes (code, owner_device_hash)
     VALUES ($1, $2)
     ON CONFLICT (code) DO NOTHING`,
    [cleanCode, ownerHash]
  );
}

export async function redeemReferralCode(
  code: string,
  deviceId: string
): Promise<{ accepted: boolean; status: number; message: string }> {
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const devHash = hashDeviceId(deviceId);
  if (cleanCode.length !== 6 || !devHash) {
    return { accepted: false, status: 400, message: "Enter a valid 6-character invite code." };
  }

  if (!pool) {
    const ref = memoryReferrals.get(cleanCode);
    if (!ref) return { accepted: false, status: 404, message: "That invite code wasn't found. Ask your friend to open Bubstock once to activate their code." };
    if (ref.ownerHash === devHash) return { accepted: false, status: 400, message: "That's your own code. Share it with a friend instead." };
    if (memoryDeviceClaims.has(devHash)) return { accepted: false, status: 409, message: "This device has already redeemed a free preview invite." };
    ref.redeemers.add(devHash);
    memoryDeviceClaims.add(devHash);
    return { accepted: true, status: 200, message: "2 months of Bubstock+ Preview unlocked!" };
  }

  const refRes = await pool.query(
    `SELECT owner_device_hash, redeemer_hashes FROM referral_codes WHERE code = $1`,
    [cleanCode]
  );
  if (refRes.rows.length === 0) {
    return { accepted: false, status: 404, message: "That invite code wasn't found. Double-check the 6 characters with your friend." };
  }
  const ownerHash = String(refRes.rows[0].owner_device_hash);
  if (ownerHash === devHash) {
    return { accepted: false, status: 400, message: "That's your own invite code — share it with a friend instead." };
  }

  const claimRes = await pool.query(
    `INSERT INTO device_promo_claims (device_hash, kind)
     VALUES ($1, 'referral')
     ON CONFLICT (device_hash) DO NOTHING
     RETURNING device_hash`,
    [devHash]
  );
  if ((claimRes.rowCount ?? 0) === 0) {
    return { accepted: false, status: 409, message: "This device has already claimed a free preview reward." };
  }

  await pool.query(
    `UPDATE referral_codes
     SET redeemer_hashes = CASE
       WHEN $2 = ANY(redeemer_hashes) THEN redeemer_hashes
       ELSE array_append(redeemer_hashes, $2)
     END
     WHERE code = $1`,
    [cleanCode, devHash]
  );

  return { accepted: true, status: 200, message: "2 months of Bubstock+ Preview unlocked! Welcome aboard." };
}

export async function getReferralCodeOwnerStatus(
  code: string,
  deviceId: string
): Promise<{ validOwner: boolean; redeemerCount: number }> {
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ownerHash = hashDeviceId(deviceId);
  if (cleanCode.length !== 6 || !ownerHash) {
    return { validOwner: false, redeemerCount: 0 };
  }

  if (!pool) {
    const ref = memoryReferrals.get(cleanCode);
    if (!ref || ref.ownerHash !== ownerHash) return { validOwner: false, redeemerCount: 0 };
    return { validOwner: true, redeemerCount: ref.redeemers.size };
  }

  try {
    const r = await pool.query(
      `SELECT owner_device_hash, COALESCE(array_length(redeemer_hashes, 1), 0)::INT AS cnt
       FROM referral_codes WHERE code = $1`,
      [cleanCode]
    );
    if (r.rows.length === 0) return { validOwner: false, redeemerCount: 0 };
    if (String(r.rows[0].owner_device_hash) !== ownerHash) {
      return { validOwner: false, redeemerCount: 0 };
    }
    return { validOwner: true, redeemerCount: Number(r.rows[0].cnt ?? 0) };
  } catch {
    return { validOwner: false, redeemerCount: 0 };
  }
}

export async function hasDeviceVerifiedPromoOrReferral(deviceId: string): Promise<boolean> {
  const devHash = hashDeviceId(deviceId);
  if (!devHash) return false;
  if (!pool) return memoryDeviceClaims.has(devHash);
  try {
    const r = await pool.query(
      `SELECT 1 FROM device_promo_claims
       WHERE device_hash = $1
         AND claimed_at >= NOW() - INTERVAL '370 days'
       LIMIT 1`,
      [devHash]
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

// ─── Mothers' Group / Playgroup Syndicate (Sybil-Resistant 3-Family Loop) ────

export interface MothersGroupStatus {
  groupCode: string;
  suburb: string;
  city: string;
  memberCount: number;
  targetCount: number;
  unlocked: boolean;
  createdAt: string;
}

const memoryGroups = new Map<string, { suburb: string; city: string; members: Set<string>; ips: string[]; createdAt: string }>();
const GROUP_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function generateGroupCode(): string {
  const bytes = crypto.randomBytes(6);
  let out = "MG";
  for (let i = 0; i < 4; i++) {
    out += GROUP_ALPHABET[bytes[i] % GROUP_ALPHABET.length];
  }
  return out;
}

function hashIp(ip?: string): string {
  return crypto.createHash("sha256").update(`bubstock-ip-v1:${ip || "unknown"}`).digest("hex").slice(0, 16);
}

export async function createMothersGroup(
  suburb: string,
  city: string,
  deviceId: string,
  clientIp?: string
): Promise<MothersGroupStatus> {
  const hash = hashDeviceId(deviceId) ?? crypto.randomUUID().slice(0, 16);
  const ipHash = hashIp(clientIp);
  const code = generateGroupCode();
  const createdAt = new Date().toISOString();

  if (!pool) {
    memoryGroups.set(code, { suburb, city, members: new Set([hash]), ips: [ipHash], createdAt });
    return { groupCode: code, suburb, city, memberCount: 1, targetCount: 3, unlocked: false, createdAt };
  }

  await pool.query(
    `INSERT INTO mothers_groups (group_code, suburb, city, member_hashes, member_ip_hashes)
     VALUES ($1, $2, $3, $4, $5)`,
    [code, suburb, city, [hash], [ipHash]]
  );
  return { groupCode: code, suburb, city, memberCount: 1, targetCount: 3, unlocked: false, createdAt };
}

export async function joinMothersGroup(
  groupCode: string,
  deviceId: string,
  clientIp?: string
): Promise<{ status: MothersGroupStatus | null; sybilBlocked?: boolean }> {
  const cleanCode = groupCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hash = hashDeviceId(deviceId) ?? crypto.randomUUID().slice(0, 16);
  const ipHash = hashIp(clientIp);

  if (!pool) {
    const g = memoryGroups.get(cleanCode);
    if (!g) return { status: null };
    if (!g.members.has(hash)) {
      const sameIpCount = g.ips.filter((x) => x === ipHash).length;
      if (sameIpCount >= 2) return { status: null, sybilBlocked: true };
      g.members.add(hash);
      g.ips.push(ipHash);
    }
    const count = g.members.size;
    return {
      status: {
        groupCode: cleanCode,
        suburb: g.suburb,
        city: g.city,
        memberCount: count,
        targetCount: 3,
        unlocked: count >= 3,
        createdAt: g.createdAt,
      },
    };
  }

  const existing = await pool.query(
    `SELECT group_code, suburb, city, member_hashes, member_ip_hashes, created_at
     FROM mothers_groups WHERE group_code = $1`,
    [cleanCode]
  );
  if (existing.rows.length === 0) return { status: null };
  const row = existing.rows[0];
  const members: string[] = Array.isArray(row.member_hashes) ? row.member_hashes : [];
  const ipHashes: string[] = Array.isArray(row.member_ip_hashes) ? row.member_ip_hashes : [];

  if (!members.includes(hash)) {
    const sameIpCount = ipHashes.filter((x) => x === ipHash).length;
    // Allow max 2 members from the same Wi-Fi/IP so 3 fake joins from 1 device/network cannot self-unlock
    if (sameIpCount >= 2) {
      return { status: null, sybilBlocked: true };
    }
    const res = await pool.query(
      `UPDATE mothers_groups
       SET member_hashes = array_append(member_hashes, $2),
           member_ip_hashes = array_append(member_ip_hashes, $3)
       WHERE group_code = $1
       RETURNING group_code, suburb, city, member_hashes, created_at`,
      [cleanCode, hash, ipHash]
    );
    const updated = res.rows[0];
    const count = Array.isArray(updated.member_hashes) ? updated.member_hashes.length : 1;
    if (count >= 3) {
      await pool.query(
        `INSERT INTO device_promo_claims (device_hash, kind) VALUES ($1, 'syndicate') ON CONFLICT (device_hash) DO NOTHING`,
        [hash]
      ).catch(() => {});
    }
    return {
      status: {
        groupCode: updated.group_code,
        suburb: updated.suburb,
        city: updated.city,
        memberCount: count,
        targetCount: 3,
        unlocked: count >= 3,
        createdAt: new Date(updated.created_at).toISOString(),
      },
    };
  }

  const count = members.length;
  return {
    status: {
      groupCode: row.group_code,
      suburb: row.suburb,
      city: row.city,
      memberCount: count,
      targetCount: 3,
      unlocked: count >= 3,
      createdAt: new Date(row.created_at).toISOString(),
    },
  };
}

export async function getMothersGroup(groupCode: string): Promise<MothersGroupStatus | null> {
  const cleanCode = groupCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!pool) {
    const g = memoryGroups.get(cleanCode);
    if (!g) return null;
    const count = g.members.size;
    return {
      groupCode: cleanCode,
      suburb: g.suburb,
      city: g.city,
      memberCount: count,
      targetCount: 3,
      unlocked: count >= 3,
      createdAt: g.createdAt,
    };
  }
  const r = await pool.query(
    `SELECT group_code, suburb, city, member_hashes, created_at FROM mothers_groups WHERE group_code = $1`,
    [cleanCode]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const count = Array.isArray(row.member_hashes) ? row.member_hashes.length : 0;
  return {
    groupCode: row.group_code,
    suburb: row.suburb,
    city: row.city,
    memberCount: count,
    targetCount: 3,
    unlocked: count >= 3,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ─── Suburb-Level Formula & Essential Shortage Heatmap ───────────────────────

export interface SuburbShortageItem {
  id: string;
  productId: string;
  productName: string;
  suburb: string;
  retailer: string;
  outCount: number;
  lowCount: number;
  reporterCount: number;
  severity: "high" | "watch";
  lastReportedAt: string;
}

export async function getSuburbShortages(hours = 24): Promise<SuburbShortageItem[]> {
  const windowHrs = Math.min(Math.max(hours, 4), 72);
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT
         product_id,
         COALESCE(MAX(product_name), product_id) AS product_name,
         suburb,
         retailer,
         COUNT(*) FILTER (WHERE state = 'likelyGone')::INT AS out_cnt,
         COUNT(*) FILTER (WHERE state = 'runningLow')::INT AS low_cnt,
         COUNT(DISTINCT COALESCE(device_hash, id))::INT AS reporters,
         MAX(reported_at) AS last_reported
       FROM shelf_sightings
       WHERE reported_at >= NOW() - ($1 || ' hours')::INTERVAL
         AND is_shadow_banned = FALSE
         AND state IN ('likelyGone', 'runningLow')
       GROUP BY product_id, suburb, retailer
       ORDER BY out_cnt DESC, reporters DESC, last_reported DESC
       LIMIT 30`,
      [windowHrs]
    );
    return res.rows.map((r) => ({
      id: `${r.product_id}|${r.suburb}|${r.retailer}`,
      productId: String(r.product_id),
      productName: String(r.product_name),
      suburb: String(r.suburb),
      retailer: String(r.retailer),
      outCount: Number(r.out_cnt),
      lowCount: Number(r.low_cnt),
      reporterCount: Number(r.reporters),
      severity: Number(r.out_cnt) >= 2 ? "high" : "watch",
      lastReportedAt: new Date(r.last_reported).toISOString(),
    }));
  } catch (err) {
    console.error("[db] getSuburbShortages error:", (err as Error).message);
    return [];
  }
}

// ─── 90-Day Unit-Price & Pack-Size Shrinkflation Detector ────────────────────

export interface ShrinkflationAlert {
  id: string;
  productName: string;
  retailer: string;
  oldUnit: string;
  newUnit: string;
  oldPrice: number;
  newPrice: number;
  unitPriceJumpPercent: number;
  packShrinkDescription: string;
  firstObservedAt: string;
  latestObservedAt: string;
}

function parseUnitDollars(unit: string): number | null {
  const m = unit.match(/\$\s*(\d+(?:\.\d{1,3})?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function parsePackMeasure(text: string): { qty: number; kind: string } | null {
  const m = text.match(/\b(\d{2,4})\s*(pack|pk|nappies|wipes|g|ml)\b/i);
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isFinite(qty) || qty < 10) return null;
  const rawKind = m[2].toLowerCase();
  const kind = rawKind === "pk" || rawKind === "nappies" || rawKind === "wipes" ? "pack" : rawKind;
  return { qty, kind };
}

export async function detectShrinkflation(productFilter?: string): Promise<ShrinkflationAlert[]> {
  if (!pool) return [];
  try {
    const params: string[] = [];
    let filterSql = "";
    if (productFilter && productFilter.trim().length >= 3) {
      params.push(productFilter.trim().toLowerCase());
      filterSql = `AND (lower(product_name) LIKE '%' || $1 || '%' OR lower(matched_name) LIKE '%' || $1 || '%')`;
    }

    const res = await pool.query(
      `WITH ranked AS (
         SELECT
           lower(product_name) AS pkey,
           retailer,
           matched_name,
           price::FLOAT8 AS price,
           COALESCE(unit, '') AS unit,
           fetched_at,
           ROW_NUMBER() OVER (PARTITION BY lower(product_name), retailer ORDER BY fetched_at ASC) AS rn_first,
           ROW_NUMBER() OVER (PARTITION BY lower(product_name), retailer ORDER BY fetched_at DESC) AS rn_last
         FROM price_entries
         WHERE fetched_at >= NOW() - INTERVAL '90 days'
           AND price > 0.5
           ${filterSql}
       )
       SELECT
         a.pkey,
         a.retailer,
         a.matched_name AS old_name,
         b.matched_name AS new_name,
         a.price AS old_price,
         b.price AS new_price,
         a.unit AS old_unit,
         b.unit AS new_unit,
         a.fetched_at AS first_at,
         b.fetched_at AS last_at
       FROM ranked a
       JOIN ranked b
         ON a.pkey = b.pkey AND a.retailer = b.retailer
       WHERE a.rn_first = 1 AND b.rn_last = 1
         AND b.fetched_at >= a.fetched_at + INTERVAL '5 days'
       LIMIT 200`,
      params
    );

    const alerts: ShrinkflationAlert[] = [];
    for (const r of res.rows) {
      const oldU = parseUnitDollars(String(r.old_unit));
      const newU = parseUnitDollars(String(r.new_unit));
      const oldMeasure = parsePackMeasure(String(r.old_name ?? ""));
      const newMeasure = parsePackMeasure(String(r.new_name ?? ""));

      let jumpPct = 0;
      let desc = "";

      if (oldMeasure && newMeasure && oldMeasure.kind === newMeasure.kind && newMeasure.qty < oldMeasure.qty) {
        const oldPerUnit = Number(r.old_price) / oldMeasure.qty;
        const newPerUnit = Number(r.new_price) / newMeasure.qty;
        jumpPct = Math.round(((newPerUnit - oldPerUnit) / oldPerUnit) * 100);
        if (jumpPct >= 6) {
          desc = `Pack shrank from ${oldMeasure.qty}${oldMeasure.kind} to ${newMeasure.qty}${newMeasure.kind} (+${jumpPct}% real unit cost)`;
        }
      } else if (oldU && newU && newU > oldU * 1.08 && Number(r.new_price) >= Number(r.old_price) * 0.98) {
        jumpPct = Math.round(((newU - oldU) / oldU) * 100);
        desc = `Unit price rose +${jumpPct}% (${r.old_unit} → ${r.new_unit})`;
      }

      if (jumpPct >= 6 && desc) {
        alerts.push({
          id: `${r.retailer}|${r.pkey}`,
          productName: String(r.new_name || r.pkey),
          retailer: String(r.retailer),
          oldUnit: String(r.old_unit),
          newUnit: String(r.new_unit),
          oldPrice: Number(r.old_price),
          newPrice: Number(r.new_price),
          unitPriceJumpPercent: jumpPct,
          packShrinkDescription: desc,
          firstObservedAt: new Date(r.first_at).toISOString(),
          latestObservedAt: new Date(r.last_at).toISOString(),
        });
      }
    }

    return alerts.sort((a, b) => b.unitPriceJumpPercent - a.unitPriceJumpPercent).slice(0, 25);
  } catch (err) {
    console.error("[db] detectShrinkflation error:", (err as Error).message);
    return [];
  }
}

export async function getCategoryMedians(): Promise<{ formula: number | null; nappies: number | null }> {
  if (!pool) return { formula: null, nappies: null };
  try {
    const [fRes, nRes] = await Promise.all([
      pool.query(
        `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)::FLOAT8 AS med
         FROM price_entries
         WHERE fetched_at >= NOW() - INTERVAL '30 days'
           AND (lower(product_name) LIKE '%formula%' OR lower(matched_name) LIKE '%formula%' OR lower(product_name) LIKE '%aptamil%' OR lower(product_name) LIKE '%karicare%')
           AND price >= 12`
      ),
      pool.query(
        `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)::FLOAT8 AS med
         FROM price_entries
         WHERE fetched_at >= NOW() - INTERVAL '30 days'
           AND (lower(product_name) LIKE '%napp%' OR lower(matched_name) LIKE '%napp%' OR lower(product_name) LIKE '%huggies%' OR lower(product_name) LIKE '%babylove%')
           AND price >= 8`
      ),
    ]);
    const fm = fRes.rows[0]?.med;
    const nm = nRes.rows[0]?.med;
    return {
      formula: Number.isFinite(fm) && fm > 0 ? Number(fm.toFixed(2)) : null,
      nappies: Number.isFinite(nm) && nm > 0 ? Number(nm.toFixed(2)) : null,
    };
  } catch {
    return { formula: null, nappies: null };
  }
}

// ─── Apple SEAR Hardware Attestation & Project Zero Deception Persistence ────

export interface AttestedKeyRecord {
  keyId: string;
  publicKeyPem: string;
  attestMode: "app_attest" | "secure_enclave" | "dev_keychain";
  appAttestCbor?: string;
  bundleId: string;
  lastCounter: number;
  taintMask: number;
  enrolledIpHash?: string;
}

const memoryAttestedKeys = new Map<string, AttestedKeyRecord>();
const memoryShadowBans = new Map<string, { strikes: number; isBanned: boolean; reason: string }>();

export async function upsertAttestedKey(rec: AttestedKeyRecord): Promise<void> {
  memoryAttestedKeys.set(rec.keyId, rec);
  if (memoryAttestedKeys.size > 10_000) {
    const oldest = memoryAttestedKeys.keys().next().value;
    if (oldest) memoryAttestedKeys.delete(oldest);
  }
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO attested_keys
         (key_id, public_key_pem, attest_mode, app_attest_cbor, bundle_id, last_counter, taint_mask, enrolled_ip_hash, enrolled_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT (key_id) DO UPDATE SET
         public_key_pem = EXCLUDED.public_key_pem,
         attest_mode = EXCLUDED.attest_mode,
         app_attest_cbor = COALESCE(EXCLUDED.app_attest_cbor, attested_keys.app_attest_cbor),
         bundle_id = EXCLUDED.bundle_id,
         taint_mask = GREATEST(attested_keys.taint_mask, EXCLUDED.taint_mask),
         last_seen_at = NOW()`,
      [
        rec.keyId,
        rec.publicKeyPem,
        rec.attestMode,
        rec.appAttestCbor ?? null,
        rec.bundleId,
        rec.lastCounter,
        rec.taintMask,
        rec.enrolledIpHash ?? null,
      ]
    );
  } catch (err) {
    console.error("[db] upsertAttestedKey error:", (err as Error).message);
  }
}

export async function loadAttestedKey(keyId: string): Promise<AttestedKeyRecord | null> {
  const cached = memoryAttestedKeys.get(keyId);
  if (cached) return cached;
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT key_id, public_key_pem, attest_mode, app_attest_cbor, bundle_id, last_counter, taint_mask, enrolled_ip_hash
       FROM attested_keys
       WHERE key_id = $1`,
      [keyId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    const rec: AttestedKeyRecord = {
      keyId: String(r.key_id),
      publicKeyPem: String(r.public_key_pem),
      attestMode: (r.attest_mode === "app_attest" || r.attest_mode === "dev_keychain"
        ? r.attest_mode
        : "secure_enclave") as AttestedKeyRecord["attestMode"],
      appAttestCbor: r.app_attest_cbor ?? undefined,
      bundleId: String(r.bundle_id ?? "au.com.bubstock.app"),
      lastCounter: Number(r.last_counter ?? 0),
      taintMask: Number(r.taint_mask ?? 0),
      enrolledIpHash: r.enrolled_ip_hash ?? undefined,
    };
    memoryAttestedKeys.set(keyId, rec);
    return rec;
  } catch {
    return null;
  }
}

export async function updateAttestedKeyState(
  keyId: string,
  highestCounter: number,
  taintMask: number
): Promise<void> {
  const cached = memoryAttestedKeys.get(keyId);
  if (cached) {
    cached.lastCounter = Math.max(cached.lastCounter, highestCounter);
    cached.taintMask = cached.taintMask | taintMask;
  }
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE attested_keys
       SET last_counter = GREATEST(last_counter, $2),
           taint_mask = (taint_mask | $3),
           last_seen_at = NOW()
       WHERE key_id = $1`,
      [keyId, highestCounter, taintMask]
    );
  } catch {
    // Non-fatal telemetry update
  }
}

export async function persistHostileFingerprint(
  ipHash: string,
  reason: string,
  scoreDelta: number
): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO hostile_fingerprints (ip_hash, threat_score, reason, hit_count, first_seen_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, 1, NOW(), NOW(), NOW() + INTERVAL '7 days')
       ON CONFLICT (ip_hash) DO UPDATE SET
         threat_score = LEAST(10000, hostile_fingerprints.threat_score + $2),
         reason = $3,
         hit_count = hostile_fingerprints.hit_count + 1,
         last_seen_at = NOW(),
         expires_at = NOW() + INTERVAL '7 days'`,
      [ipHash, scoreDelta, reason.slice(0, 120)]
    );
  } catch (err) {
    console.error("[db] persistHostileFingerprint error:", (err as Error).message);
  }
}

export async function loadActiveHostileFingerprints(): Promise<Array<{ ipHash: string; threatScore: number; reason: string; expiresAtMs: number }>> {
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT ip_hash, threat_score, reason, expires_at
       FROM hostile_fingerprints
       WHERE expires_at > NOW()
       ORDER BY last_seen_at DESC
       LIMIT 5000`
    );
    return res.rows.map((r) => ({
      ipHash: String(r.ip_hash),
      threatScore: Number(r.threat_score ?? 100),
      reason: String(r.reason ?? "hostile"),
      expiresAtMs: new Date(r.expires_at).getTime(),
    }));
  } catch {
    return [];
  }
}

export async function logHoneypotHit(
  ipHash: string,
  path: string,
  method: string,
  userAgent: string,
  reason: string
): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO honeypot_hits (ip_hash, path, method, user_agent, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [ipHash, path.slice(0, 160), method.slice(0, 16), userAgent.slice(0, 180), reason.slice(0, 120)]
    );
    // Keep table bounded to last 30 days
    await pool.query(`DELETE FROM honeypot_hits WHERE created_at < NOW() - INTERVAL '30 days'`).catch(() => {});
  } catch {
    // Non-fatal logging
  }
}

export async function isDeviceShadowBanned(deviceId?: string): Promise<boolean> {
  const hash = hashDeviceId(deviceId);
  if (!hash) return false;
  const cached = memoryShadowBans.get(hash);
  if (cached?.isBanned) return true;
  if (!pool) return false;
  try {
    const res = await pool.query(
      `SELECT strikes, is_banned, reason FROM shadow_banned_devices WHERE device_hash = $1`,
      [hash]
    );
    if (res.rows.length === 0) return false;
    const row = res.rows[0];
    memoryShadowBans.set(hash, {
      strikes: Number(row.strikes ?? 1),
      isBanned: Boolean(row.is_banned),
      reason: String(row.reason ?? ""),
    });
    return Boolean(row.is_banned);
  } catch {
    return false;
  }
}

export async function recordDeviceStrike(
  deviceId: string | undefined,
  reason: string,
  forceBan = false
): Promise<{ strikes: number; isBanned: boolean }> {
  const hash = hashDeviceId(deviceId);
  if (!hash) return { strikes: 0, isBanned: forceBan };

  const cur = memoryShadowBans.get(hash) ?? { strikes: 0, isBanned: false, reason };
  const nextStrikes = cur.strikes + 1;
  const nextBanned = forceBan || cur.isBanned || nextStrikes >= 2;
  memoryShadowBans.set(hash, { strikes: nextStrikes, isBanned: nextBanned, reason });

  if (!pool) {
    return { strikes: nextStrikes, isBanned: nextBanned };
  }
  try {
    const res = await pool.query(
      `INSERT INTO shadow_banned_devices (device_hash, strikes, is_banned, reason, updated_at)
       VALUES ($1, 1, $2, $3, NOW())
       ON CONFLICT (device_hash) DO UPDATE SET
         strikes = shadow_banned_devices.strikes + 1,
         is_banned = shadow_banned_devices.is_banned OR $2 OR (shadow_banned_devices.strikes + 1) >= 2,
         reason = $3,
         updated_at = NOW()
       RETURNING strikes, is_banned`,
      [hash, forceBan, reason.slice(0, 120)]
    );
    const strikes = Number(res.rows[0]?.strikes ?? nextStrikes);
    const isBanned = Boolean(res.rows[0]?.is_banned ?? nextBanned);
    memoryShadowBans.set(hash, { strikes, isBanned, reason });
    return { strikes, isBanned };
  } catch {
    return { strikes: nextStrikes, isBanned: nextBanned };
  }
}

export async function countRecentLikelyGoneByDevice(deviceId?: string, minutes = 10): Promise<number> {
  const hash = hashDeviceId(deviceId);
  if (!hash) return 0;
  if (!pool) {
    const cutoff = Date.now() - minutes * 60_000;
    return memorySightingsWithHash.filter(
      (s) => s.deviceHash === hash && s.state === "likelyGone" && new Date(s.reportedAt).getTime() >= cutoff
    ).length;
  }
  try {
    const res = await pool.query(
      `SELECT COUNT(DISTINCT store_id)::INT AS cnt
       FROM shelf_sightings
       WHERE device_hash = $1
         AND state = 'likelyGone'
         AND reported_at >= NOW() - ($2 || ' minutes')::INTERVAL`,
      [hash, minutes]
    );
    return Number(res.rows[0]?.cnt ?? 0);
  } catch {
    return 0;
  }
}

export async function getSecurityTelemetrySummary(): Promise<{
  attestedKeys: { total: number; appAttest: number; secureEnclave: number; devKeychain: number; tainted: number };
  hostileFingerprintsActive: number;
  honeypotHitsLast24h: number;
  shadowBannedDevices: number;
  shadowBannedSightings: number;
  recentHoneypotHits: Array<{ path: string; method: string; reason: string; createdAt: string }>;
}> {
  if (!pool) {
    let appAttest = 0;
    let secureEnclave = 0;
    let devKeychain = 0;
    let tainted = 0;
    for (const k of memoryAttestedKeys.values()) {
      if (k.attestMode === "app_attest") appAttest++;
      else if (k.attestMode === "secure_enclave") secureEnclave++;
      else devKeychain++;
      if (k.taintMask > 0) tainted++;
    }
    return {
      attestedKeys: { total: memoryAttestedKeys.size, appAttest, secureEnclave, devKeychain, tainted },
      hostileFingerprintsActive: 0,
      honeypotHitsLast24h: 0,
      shadowBannedDevices: [...memoryShadowBans.values()].filter((v) => v.isBanned).length,
      shadowBannedSightings: memorySightingsWithHash.filter((s) => s.isShadowBanned).length,
      recentHoneypotHits: [],
    };
  }
  try {
    const [keysRes, hostileRes, hitsCountRes, shadowDevRes, shadowSightRes, recentHitsRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::INT AS total,
           COUNT(*) FILTER (WHERE attest_mode = 'app_attest')::INT AS app_attest,
           COUNT(*) FILTER (WHERE attest_mode = 'secure_enclave')::INT AS secure_enclave,
           COUNT(*) FILTER (WHERE attest_mode = 'dev_keychain')::INT AS dev_keychain,
           COUNT(*) FILTER (WHERE taint_mask > 0)::INT AS tainted
         FROM attested_keys`
      ),
      pool.query(`SELECT COUNT(*)::INT AS cnt FROM hostile_fingerprints WHERE expires_at > NOW()`),
      pool.query(`SELECT COUNT(*)::INT AS cnt FROM honeypot_hits WHERE created_at >= NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*)::INT AS cnt FROM shadow_banned_devices WHERE is_banned = TRUE`),
      pool.query(`SELECT COUNT(*)::INT AS cnt FROM shelf_sightings WHERE is_shadow_banned = TRUE`),
      pool.query(
        `SELECT path, method, reason, created_at
         FROM honeypot_hits
         ORDER BY created_at DESC
         LIMIT 20`
      ),
    ]);
    const kr = keysRes.rows[0] ?? {};
    return {
      attestedKeys: {
        total: Number(kr.total ?? 0),
        appAttest: Number(kr.app_attest ?? 0),
        secureEnclave: Number(kr.secure_enclave ?? 0),
        devKeychain: Number(kr.dev_keychain ?? 0),
        tainted: Number(kr.tainted ?? 0),
      },
      hostileFingerprintsActive: Number(hostileRes.rows[0]?.cnt ?? 0),
      honeypotHitsLast24h: Number(hitsCountRes.rows[0]?.cnt ?? 0),
      shadowBannedDevices: Number(shadowDevRes.rows[0]?.cnt ?? 0),
      shadowBannedSightings: Number(shadowSightRes.rows[0]?.cnt ?? 0),
      recentHoneypotHits: recentHitsRes.rows.map((r) => ({
        path: String(r.path),
        method: String(r.method),
        reason: String(r.reason),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  } catch {
    return {
      attestedKeys: { total: 0, appAttest: 0, secureEnclave: 0, devKeychain: 0, tainted: 0 },
      hostileFingerprintsActive: 0,
      honeypotHitsLast24h: 0,
      shadowBannedDevices: 0,
      shadowBannedSightings: 0,
      recentHoneypotHits: [],
    };
  }
}

export async function pruneStaleRecords(): Promise<void> {
  if (!pool) return;
  try {
    await Promise.all([
      pool.query(`DELETE FROM sent_push_alerts WHERE sent_at < NOW() - INTERVAL '30 days'`),
      pool.query(`DELETE FROM price_entries WHERE fetched_at < NOW() - INTERVAL '370 days'`),
      pool.query(`DELETE FROM hostile_fingerprints WHERE expires_at < NOW()`),
      pool.query(`DELETE FROM honeypot_hits WHERE created_at < NOW() - INTERVAL '30 days'`),
    ]);
  } catch (err) {
    console.error("[db] pruneStaleRecords error:", (err as Error).message);
  }
}
