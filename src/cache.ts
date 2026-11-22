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

class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor() {
    setInterval(() => this.evict(), 5 * 60 * 1000).unref();
  }

  set(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
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

export const priceCache = new TTLCache<ProductPriceResult>();
export const recallCache = new TTLCache<RecallEntry[]>();
export const specialsCache = new TTLCache<SpecialEntry[]>();
export const storesCache = new TTLCache<MelbourneStore[]>();
