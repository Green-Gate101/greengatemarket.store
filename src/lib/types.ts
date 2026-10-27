/**
 * Shared API contracts (typed request/response models).
 * Money is carried as integer cents everywhere; formatting happens at the edge.
 */

export type Role = 'BUYER' | 'SELLER' | 'ADMIN';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  emailVerified: boolean;
}

export interface StoreDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoData: string | null;
  bannerData: string | null;
  location: string;
  createdAt: string;
  productCount?: number;
}

export interface CategoryDto {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  children?: CategoryDto[];
}

export interface ProductVariantDto {
  id: string;
  sku: string;
  attributes: Record<string, string>;
  priceCents: number | null;
  stock: number;
  imageData?: string | null;
}

export interface ProductImageDto {
  id: string;
  dataUrl: string;
  position: number;
}

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  priceCents: number;
  salePriceCents: number | null;
  image: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  brand: string | null;
  stock: number;
  /** Stock across active sizes/variants — products with variants keep `stock` at 0. */
  variantStock?: number;
  /** The buyer picks a size/variant on the product page before adding to cart. */
  hasVariants?: boolean;
  status: string;
  createdAt: string;
  ratingAvg: number;
  ratingCount: number;
  store: { id: string; slug: string; name: string; location: string };
}

export interface ProductDetail extends ProductSummary {
  description: string;
  condition: string;
  /** Comma-separated tag string as stored on the product record. */
  tags: string;
  weightGrams: number;
  /** Declared parcel size in cm — drives the courier's volumetric pricing. */
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  images: ProductImageDto[];
  variants: ProductVariantDto[];
  viewCount: number;
  reviews: ReviewDto[];
  /** False when the seller has no connected payment processor (cannot be bought). */
  canBuy?: boolean;
  store: ProductSummary['store'] & { verified?: boolean; pickup?: StorePickupDto };
}

/** A pickup-point option a store offers (null = not offered). */
export type PickupOfferDto = { priceCents: number; eta: string } | null;
export interface StorePickupDto { paxi: PickupOfferDto; pudo: PickupOfferDto }

export interface ReviewDto {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  verified: boolean;
  createdAt: string;
  authorName: string | null;
}

export interface CartLineDto {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  name: string;
  image: string | null;
  unitPriceCents: number;
  stock: number;
  slug: string;
  store: { id: string; slug: string; name: string; location: string; pickup?: StorePickupDto; hasDiscounts?: boolean };
}

export interface WishlistLineDto {
  id: string;
  productId: string;
  slug: string;
  name: string;
  image: string | null;
  priceCents: number;
  salePriceCents: number | null;
  stock: number;
  /** Stock across active sizes/variants (see ProductSummary). */
  variantStock?: number;
  hasVariants?: boolean;
  storeName: string;
}

export interface ShippingOption {
  code: string;
  label: string;
  eta: string;
  priceCents: number;
  provider: string;
}

export type OrderStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'processing'
  | 'packed'
  | 'ready_for_collection'
  | 'shipped'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'returned'
  | 'refunded';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: 'Pending payment',
  confirmed: 'Payment confirmed',
  processing: 'Processing',
  packed: 'Packed',
  ready_for_collection: 'Ready for collection',
  shipped: 'Shipped',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
  refunded: 'Refunded',
};

/** Statuses that count as real sales in analytics. */
export const SALE_STATUSES: OrderStatus[] = [
  'confirmed',
  'processing',
  'packed',
  'ready_for_collection',
  'shipped',
  'in_transit',
  'out_for_delivery',
  'delivered',
];

export interface OrderItemDto {
  id: string;
  productId: string;
  name: string;
  variantLabel: string | null;
  quantity: number;
  unitPriceCents: number;
  /** Attached by seller order listings (first product photo). */
  image?: string | null;
}

export interface OrderEventDto {
  id: string;
  status: string;
  note: string | null;
  createdAt: string;
}

export interface OrderDto {
  id: string;
  number: string;
  status: OrderStatus;
  paymentStatus: string;
  paymentRef: string | null;
  buyerName: string;
  buyerEmail: string;
  address: string;
  shippingMethod: string;
  shippingCents: number;
  subtotalCents: number;
  /** A seller's discount code used on this order (taken off the items). */
  discountCode?: string | null;
  discountCents?: number;
  totalCents: number;
  createdAt: string;
  items: OrderItemDto[];
  events?: OrderEventDto[];
  store?: { id: string; slug: string; name: string; payoutProvider?: string | null; payoutLink?: string | null; payoutNote?: string | null; payfastReady?: boolean; ozowReady?: boolean; yocoReady?: boolean; eft?: EftDetailsDto | null };
  deliveryLat?: number | null;  // exact GPS pin handed to The Courier Guy
  deliveryLng?: number | null;
  deliveryAccuracyMeters?: number | null;
  deliveryPinSource?: string | null; // gps | saved_default
}

export interface DailyPoint {
  date: string;
  label: string;
  revenue: number;
  orders: number;
  units: number;
  views: number;
}

export interface AnalyticsDto {
  totals: {
    revenueCents: number;
    orders: number;
    units: number;
    avgOrderValueCents: number;
    views: number;
    addToLists: number;
    conversionPct: number | null;
    products: number;
    lowStock: number;
    outOfStock: number;
  };
  daily: DailyPoint[];
  categories: { category: string; revenue: number }[];
  topProducts: { productId: string; name: string; units: number; revenue: number; views: number }[];
  recentOrders: OrderDto[];
  /** Set when the period reaches past the kept product events: views/adds start here. */
  viewsCoverFrom?: string | null;
  eventsKeptDays?: number;
}

export interface AdminOverview {
  users: { total: number; sellers: number; buyers: number; recent: { id?: string; email: string; name: string | null; role: string; banned?: boolean; phone?: string | null; createdAt: string }[] };
  stores: { id: string; slug: string; name: string; email: string; status: string; productCount: number; createdAt: string }[];
  products: { total: number; pending: number; approved: number; disabled: number };
  orders: { total: number; pendingPayment: number; sales: number; revenueCents: number; recent: OrderDto[] };
  categories: CategoryDto[];
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: { service: string; ok: boolean; detail: string }[];
  time: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Friendly names for the payment processors a seller may accept. Used on the
// seller dashboard form and the buyer-facing "Pay online" buttons.
// SnapScan and Stripe were removed at the owner's request — they are no longer
// selectable; any legacy store values still render via the ?? fallbacks.
export const PAYMENT_PROVIDER_LABELS: Record<string, string> = {
  bank_transfer: 'Bank transfer (EFT)',
  payfast: 'PayFast',
  ozow: 'Ozow (Instant EFT)',
  yoco: 'Yoco',
  mastercard: 'Mastercard',
  other: 'the seller’s payment page',
};

/** Seller's bank details for paying an order by EFT (buyer's own unpaid orders only). */
export interface EftDetailsDto {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  branchCode: string | null;
  accountType: string | null;
}

export function formatMoney(cents: number, currency = 'ZAR'): string {
  const value = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency, minimumFractionDigits: 2 }).format(value);
  } catch {
    return `R ${value.toFixed(2)}`;
  }
}

export function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
