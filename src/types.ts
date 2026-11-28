export type AuCity = "melbourne" | "sydney" | "brisbane" | "perth" | "adelaide" | "tasmania";
export type AuStateUpper = "VIC" | "NSW" | "QLD" | "WA" | "SA" | "TAS";
export type AuStateLower = "vic" | "nsw" | "qld" | "wa" | "sa" | "tas" | "act" | "nt";

export type FeedStatusKind = "live" | "no_match" | "unavailable";

export interface RetailerFeedStatus {
  retailer: string;
  status: FeedStatusKind;
  count: number;
  latencyMs: number;
  note?: string;
}

export interface PriceEntry {
  retailer: string;
  storeName: string;
  suburb: string;
  state: string;
  matchedName: string;
  brand?: string;
  stockcode?: string;
  barcode?: string;
  price: number;
  wasPrice?: number;
  savingsPercent?: number;
  currency: "AUD";
  unit: string;
  isOnSale: boolean;
  saleEndsAt?: string;
  isInStock?: boolean;
  imageUrl?: string;
  productUrl?: string;
  lastUpdated: string;
}

export interface AldiEquivalent {
  categoryLabel: string;
  entry: PriceEntry;
  note: string;
}

export interface ProductPriceResult {
  productName: string;
  barcode?: string;
  suburb: string;
  state: string;
  entries: PriceEntry[];
  retailerStatus: RetailerFeedStatus[];
  aldiEquivalent?: AldiEquivalent;
  fetchedAt: string;
}

export interface SpecialEntry {
  id: string;
  retailer: string;
  name: string;
  brand?: string;
  category: "formula" | "pouch" | "nappies" | "cereal" | "snack" | "other";
  price: number;
  wasPrice: number;
  savingsAmount: number;
  savingsPercent: number;
  unit: string;
  isInStock?: boolean;
  imageUrl?: string;
  productUrl?: string;
  saleEndsAt?: string;
  lastUpdated: string;
  verifiedMedianPrice?: number;
  realDiscountPercent?: number;
  isInflatedSpecial?: boolean;
}

export interface RecallEntry {
  id: string;
  agency: "FSANZ" | "ACCC" | "NSW Food" | "VIC Health";
  productName: string;
  brand: string;
  recallDate: string;
  reason: string;
  states?: string[];
  affectedAllergens: string[];
  affectedBarcodes: string[];
  recallUrl: string;
  isActive: boolean;
}

export interface RecallCheckResult {
  recalled: boolean;
  matches: RecallEntry[];
  checkedAt: string;
}

export type StockStateValue = "onShelf" | "runningLow" | "likelyGone";

export interface ShelfSighting {
  id: string;
  productId: string;
  productName?: string;
  storeId: string;
  storeName: string;
  suburb: string;
  retailer: string;
  state: StockStateValue;
  observedPrice?: number;
  note?: string;
  corroborationCount?: number;
  verifiedByCommunity?: boolean;
  reportedAt: string;
}

export interface TradingHoursEntry {
  weekday: number; // 1 = Sun ... 7 = Sat (matches Swift Calendar)
  openMinute: number;
  closeMinute: number;
}

export interface MelbourneStore {
  id: string;
  retailer: "woolworths" | "coles" | "aldi" | "iga" | "chemistWarehouse" | "priceline" | "babyBunting" | "costco";
  storeNo?: string;
  name: string;
  streetAddress: string;
  suburb: string;
  state: AuStateLower;
  postcode: string;
  latitude: number;
  longitude: number;
  phone?: string;
  hours: TradingHoursEntry[];
  hasDedicatedBabyAisle: boolean;
  source: "woolworths_api" | "aldi_api" | "iga_api" | "priceline_api";
}

export interface HeadToHeadComparison {
  query: string;
  suburb: string;
  state: string;
  matchQuality: "exact" | "unit_matched" | "single_retailer" | "no_match";
  woolworths: (PriceEntry & { unitMetric?: { value: number; label: string } }) | null;
  coles: (PriceEntry & { unitMetric?: { value: number; label: string } }) | null;
  cheaperRetailer: "Woolworths" | "Coles" | "Tie" | null;
  priceDifference: number | null;
  percentDifference: number | null;
  unitSummary: string | null;
  retailerStatus: RetailerFeedStatus[];
  fetchedAt: string;
}

export interface PriceGapItem {
  productKey: string;
  displayName: string;
  matchQuality: "exact" | "unit_matched";
  woolworths: {
    matchedName: string;
    price: number;
    wasPrice?: number;
    unit: string;
    isInStock?: boolean;
    imageUrl?: string;
    productUrl?: string;
    lastUpdated: string;
  };
  coles: {
    matchedName: string;
    price: number;
    wasPrice?: number;
    unit: string;
    isInStock?: boolean;
    imageUrl?: string;
    productUrl?: string;
    lastUpdated: string;
  };
  cheaperRetailer: "Woolworths" | "Coles" | "Tie";
  savingsAmount: number;
  savingsPercent: number;
}

export interface MelbournePulse {
  region: string;
  city?: AuCity;
  state?: AuStateUpper;
  activeRecallsCount: number;
  liveSpecialsCount: number;
  biggestSavingPercent: number | null;
  sightingsLast24h: number;
  storesTracked: number;
  retailers: Array<{ name: string; mode: "live_api" | "in_store_only" }>;
  updatedAt: string;
}
