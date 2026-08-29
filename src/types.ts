export interface PriceEntry {
  retailer: string;
  storeName: string;
  suburb: string;
  state: string;
  price: number;
  currency: "AUD";
  unit: string;
  isOnSale: boolean;
  saleEndsAt?: string;
  lastUpdated: string;
}

export interface ProductPriceResult {
  productName: string;
  barcode?: string;
  entries: PriceEntry[];
  fetchedAt: string;
}

export interface RecallEntry {
  id: string;
  productName: string;
  brand: string;
  recallDate: string;
  reason: string;
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
