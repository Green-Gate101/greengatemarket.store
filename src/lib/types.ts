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
  status: string;
  createdAt: string;
  ratingAvg: number;
  ratingCount: number;
  store: { id: string; slug: string; name: string; location: string };
}

export interface ProductDetail extends ProductSummary {
  description: string;
  condition: string;
  tags: string[];
  weightGrams: number;
  images: ProductImageDto[];
  variants: ProductVariantDto[];
  viewCount: number;
  reviews: ReviewDto[];
}

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
  store: { id: string; slug: string; name: string; location: string };
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
  totalCents: number;
  createdAt: string;
  items: OrderItemDto[];
  events?: OrderEventDto[];
  store?: { id: string; slug: string; name: string };
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
}

export interface AdminOverview {
  users: { total: number; sellers: number; buyers: number; recent: { email: string; name: string | null; role: string; createdAt: string }[] };
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
