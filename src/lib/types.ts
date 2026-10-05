export interface SellerDto {
  id: string;
  storeName: string;
  ownerName: string;
  email: string;
  phone: string;
  location: string;
  createdAt: string;
  productCount?: number;
}

export interface ProductDto {
  id: string;
  sellerId: string;
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number;
  imageData: string;
  createdAt: string;
  seller?: {
    id: string;
    storeName: string;
    location: string;
  };
}

export interface OrderItemDto {
  id: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  product?: { id: string; name: string; imageData: string };
}

export interface OrderDto {
  id: string;
  sellerId: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  address: string;
  shippingMethod: string;
  shippingCost: number;
  subtotal: number;
  total: number;
  status: string;
  createdAt: string;
  items: OrderItemDto[];
}

export interface DailyPoint {
  date: string;
  label: string;
  revenue: number;
  orders: number;
  units: number;
}

export interface CategorySlice {
  category: string;
  revenue: number;
}

export interface TopProduct {
  productId: string;
  name: string;
  units: number;
  revenue: number;
}

export interface AnalyticsDto {
  totals: {
    revenue: number;
    orders: number;
    units: number;
    avgOrderValue: number;
    products: number;
    lowStock: number;
    outOfStock: number;
  };
  daily: DailyPoint[];
  categories: CategorySlice[];
  topProducts: TopProduct[];
  recentOrders: OrderDto[];
}

export interface ShippingOption {
  code: string;
  label: string;
  eta: string;
  price: number;
  provider: string;
}

export const CATEGORIES = [
  'Fashion & Accessories',
  'Electronics',
  'Home & Living',
  'Beauty & Wellness',
  'Food & Drink',
  'Art & Crafts',
  'Sports & Outdoors',
] as const;
