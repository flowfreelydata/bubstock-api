import type {
  MelbourneStore,
  ProductPriceResult,
  RecallEntry,
  SpecialEntry,
} from "./types.js";

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Bounded LRU-style TTL cache so Railway container RAM stays flat (~45 MB)
 * even under heavy viral traffic spikes across Melbourne & Sydney.
 */
class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 400) {
    this.maxEntries = maxEntries;
    setInterval(() => this.evict(), 5 * 60 * 1000).unref();
  }

  set(key: string, data: T, ttlMs: number): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      // Evict oldest entry (Map preserves insertion order)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Refresh recency for LRU
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.data;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}

/**
 * In-flight request coalescing (Singleflight):
 * If 500 parents look up the same product simultaneously after a viral post,
 * only ONE upstream/DB call executes and all 500 requests share the result.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export const priceCache = new TTLCache<ProductPriceResult>(500);
export const recallCache = new TTLCache<RecallEntry[]>(4);
export const specialsCache = new TTLCache<SpecialEntry[]>(8);
export const storesCache = new TTLCache<MelbourneStore[]>(6);
