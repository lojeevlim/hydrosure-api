import { z } from 'zod';
import type { MovementType } from './inventory';

const isoInstant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const MAX_DASHBOARD_RANGE_DAYS = 366;

/**
 * ISO from/to (full datetimes or YYYY-MM-DD; a date-only `to` covers that whole UTC day).
 * Both default server-side to "today so far". `tz` (IANA) controls the day buckets of the trend.
 */
export const dashboardQuerySchema = z
  .object({
    from: isoInstant.optional(),
    to: isoInstant.optional(),
    tz: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').default('UTC'),
  })
  .transform((q, ctx) => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const from = q.from ? new Date(q.from) : startOfToday;
    let to = q.to ? new Date(q.to) : now;
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to = new Date(to.getTime() + 86_400_000 - 1);
    if (from.getTime() > to.getTime()) {
      ctx.addIssue({ code: 'custom', message: '"from" must not be after "to"', path: ['from'] });
      return z.NEVER;
    }
    if (to.getTime() - from.getTime() > MAX_DASHBOARD_RANGE_DAYS * 86_400_000) {
      ctx.addIssue({ code: 'custom', message: `Range must not exceed ${MAX_DASHBOARD_RANGE_DAYS} days`, path: ['to'] });
      return z.NEVER;
    }
    return { from, to, tz: q.tz };
  });
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export interface DashboardPeriodStats {
  totalSales: number;
  transactionCount: number;
  /** Net line revenue (after discounts, before tax) minus cost snapshots. Null for cashiers. */
  grossProfit: number | null;
  /** grossProfit / net revenue * 100; null when there is no revenue or for cashiers. */
  marginPct: number | null;
}

export interface DashboardChange {
  totalSalesPct: number | null;
  transactionCountPct: number | null;
  grossProfitPct: number | null;
}

export interface DashboardData {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  scope: 'all' | 'own';
  current: DashboardPeriodStats;
  previous: DashboardPeriodStats;
  /** Percent change vs the previous period; null when the previous value is 0. */
  change: DashboardChange;
  trend: { date: string; total: number; count: number }[];
  /** Sales by hour of day (0-23, in `tz`) summed over the range; meaningful for single-day ranges. */
  hourly: { hour: number; total: number; count: number }[];
  topProducts: { productId: string; sku: string; name: string; qty: number; revenue: number }[];
  recentTransactions: {
    id: string;
    number: number;
    total: number;
    createdAt: string;
    cashierName: string;
    methods: string[];
  }[];
  /** Empty for cashiers. */
  recentMovements: {
    id: string;
    type: MovementType;
    qtyChange: number;
    qtyAfter: number;
    createdAt: string;
    productName: string;
    sku: string;
  }[];
  paymentBreakdown: { method: 'cash' | 'card' | 'ewallet'; amount: number; count: number }[];
  inventory: {
    totalProducts: number;
    activeSkus: number;
    /** 0 < stock <= reorderLevel */
    lowStockCount: number;
    /** stock <= 0 */
    outOfStockCount: number;
    /** sum(stockQty * cost) of active products. Null for cashiers. */
    valuation: number | null;
    lowStockItems: { id: string; sku: string; name: string; stockQty: number; reorderLevel: number }[];
  };
}
