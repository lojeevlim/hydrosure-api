import { Router } from 'express';
import { dashboardQuerySchema, type DashboardData, type DashboardPeriodStats } from '@hydrosure/shared';
import { prisma, Prisma } from '../db';
import { actor, authenticate } from '../middleware/auth';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pct = (cur: number | null, prev: number | null) =>
  cur === null || prev === null || prev === 0 ? null : round2(((cur - prev) / prev) * 100);

interface Range {
  from: Date;
  to: Date;
  /** When true `to` is exclusive (used for the previous period so it never overlaps the current one). */
  toExclusive?: boolean;
}

async function periodStats(r: Range, cashierId: string | null): Promise<DashboardPeriodStats> {
  const createdAt = { gte: r.from, ...(r.toExclusive ? { lt: r.to } : { lte: r.to }) };
  const saleWhere: Prisma.SaleWhereInput = { status: 'completed', createdAt, ...(cashierId ? { cashierId } : {}) };
  const [agg, items] = await Promise.all([
    prisma.sale.aggregate({ where: saleWhere, _sum: { total: true }, _count: { _all: true } }),
    prisma.saleItem.findMany({ where: { sale: saleWhere }, select: { qty: true, unitCost: true, lineSubtotal: true } }),
  ]);
  const totalSales = round2(Number(agg._sum.total ?? 0));
  let revenue = 0;
  let cost = 0;
  for (const i of items) {
    revenue += Number(i.lineSubtotal);
    cost += i.qty * Number(i.unitCost);
  }
  const grossProfit = round2(revenue - cost);
  return {
    totalSales,
    transactionCount: agg._count._all,
    grossProfit,
    marginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
  };
}

/** Day keys (YYYY-MM-DD) in `tz` covering [from, to], so days without sales appear as zero. */
function dayKeys(from: Date, to: Date, tz: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keys = new Set<string>();
  for (let t = from.getTime(); t < to.getTime(); t += 12 * 3_600_000) keys.add(fmt.format(new Date(t)));
  keys.add(fmt.format(to));
  return [...keys];
}

dashboardRouter.get('/', async (req, res) => {
  const { from, to, tz } = dashboardQuerySchema.parse(req.query);
  const user = actor(req);
  const own = user.role === 'cashier';
  const cashierId = own ? user.id : null;

  const lengthMs = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - lengthMs);
  const cur: Range = { from, to };
  const prev: Range = { from: prevFrom, to: from, toExclusive: true };

  const saleWhere: Prisma.SaleWhereInput = {
    status: 'completed',
    createdAt: { gte: from, lte: to },
    ...(cashierId ? { cashierId } : {}),
  };
  const cashierSql = cashierId ? Prisma.sql`AND s."cashierId" = ${cashierId}` : Prisma.empty;

  const [
    current,
    previous,
    trendRows,
    hourlyRows,
    topGroups,
    recentSales,
    recentMovements,
    paymentGroups,
    totalProducts,
    activeSkus,
    stockCounts,
    valuationRows,
    lowStockItems,
  ] = await Promise.all([
    periodStats(cur, cashierId),
    periodStats(prev, cashierId),
    prisma.$queryRaw<{ day: string; total: number; count: bigint }[]>`
      SELECT to_char(date_trunc('day', (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
             COALESCE(SUM(s.total), 0)::float8 AS total, COUNT(*) AS count
      FROM "Sale" s
      WHERE s.status = 'completed' AND s."createdAt" >= ${from} AND s."createdAt" <= ${to} ${cashierSql}
      GROUP BY 1`,
    prisma.$queryRaw<{ hour: number; total: number; count: bigint }[]>`
      SELECT EXTRACT(HOUR FROM (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS hour,
             COALESCE(SUM(s.total), 0)::float8 AS total, COUNT(*) AS count
      FROM "Sale" s
      WHERE s.status = 'completed' AND s."createdAt" >= ${from} AND s."createdAt" <= ${to} ${cashierSql}
      GROUP BY 1`,
    prisma.saleItem.groupBy({
      by: ['productId'],
      where: { sale: saleWhere },
      _sum: { qty: true, lineTotal: true },
      orderBy: [{ _sum: { qty: 'desc' } }, { _sum: { lineTotal: 'desc' } }],
      take: 5,
    }),
    prisma.sale.findMany({
      where: saleWhere,
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { payments: { select: { method: true } }, cashier: { select: { name: true } } },
    }),
    own
      ? Promise.resolve([])
      : prisma.inventoryMovement.findMany({
          where: { createdAt: { gte: from, lte: to } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { product: { select: { name: true, sku: true } } },
        }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { sale: saleWhere },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.product.count(),
    prisma.product.count({ where: { archivedAt: null } }),
    prisma.$queryRaw<{ low: bigint; out: bigint }[]>`
      SELECT COUNT(*) FILTER (WHERE "stockQty" > 0 AND "stockQty" <= "reorderLevel") AS low,
             COUNT(*) FILTER (WHERE "stockQty" <= 0) AS out
      FROM "Product" WHERE "archivedAt" IS NULL`,
    own
      ? Promise.resolve([{ value: null as number | null }])
      : prisma.$queryRaw<{ value: number | null }[]>`
          SELECT SUM("stockQty" * cost)::float8 AS value FROM "Product" WHERE "archivedAt" IS NULL AND "stockQty" > 0`,
    prisma.$queryRaw<{ id: string; sku: string; name: string; stockQty: number; reorderLevel: number }[]>`
      SELECT id, sku, name, "stockQty", "reorderLevel" FROM "Product"
      WHERE "archivedAt" IS NULL AND "stockQty" <= "reorderLevel"
      ORDER BY "stockQty" ASC, name ASC LIMIT 8`,
  ]);

  const byDay = new Map(trendRows.map((r) => [r.day, r]));
  const trend = dayKeys(from, to, tz).map((date) => {
    const r = byDay.get(date);
    return { date, total: round2(r?.total ?? 0), count: Number(r?.count ?? 0) };
  });

  const byHour = new Map(hourlyRows.map((r) => [r.hour, r]));
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const r = byHour.get(hour);
    return { hour, total: round2(r?.total ?? 0), count: Number(r?.count ?? 0) };
  });

  const products = await prisma.product.findMany({
    where: { id: { in: topGroups.map((g) => g.productId) } },
    select: { id: true, sku: true, name: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const body: DashboardData = {
    range: { from: from.toISOString(), to: to.toISOString() },
    previousRange: { from: prevFrom.toISOString(), to: from.toISOString() },
    scope: own ? 'own' : 'all',
    current: own ? { ...current, grossProfit: null, marginPct: null } : current,
    previous: own ? { ...previous, grossProfit: null, marginPct: null } : previous,
    change: {
      totalSalesPct: pct(current.totalSales, previous.totalSales),
      transactionCountPct: pct(current.transactionCount, previous.transactionCount),
      grossProfitPct: own ? null : pct(current.grossProfit, previous.grossProfit),
    },
    trend,
    hourly,
    topProducts: topGroups.map((g) => ({
      productId: g.productId,
      sku: productById.get(g.productId)?.sku ?? '',
      name: productById.get(g.productId)?.name ?? 'Unknown product',
      qty: g._sum.qty ?? 0,
      revenue: round2(Number(g._sum.lineTotal ?? 0)),
    })),
    recentTransactions: recentSales.map((s) => ({
      id: s.id,
      number: s.number,
      total: Number(s.total),
      createdAt: s.createdAt.toISOString(),
      cashierName: s.cashier.name,
      methods: [...new Set(s.payments.map((p) => p.method))],
    })),
    recentMovements: recentMovements.map((m) => ({
      id: m.id,
      type: m.type,
      qtyChange: m.qtyChange,
      qtyAfter: m.qtyAfter,
      createdAt: m.createdAt.toISOString(),
      productName: m.product.name,
      sku: m.product.sku,
    })),
    paymentBreakdown: paymentGroups
      .map((g) => ({ method: g.method, amount: round2(Number(g._sum.amount ?? 0)), count: g._count._all }))
      .sort((a, b) => b.amount - a.amount),
    inventory: {
      totalProducts,
      activeSkus,
      lowStockCount: Number(stockCounts[0]?.low ?? 0),
      outOfStockCount: Number(stockCounts[0]?.out ?? 0),
      valuation: own ? null : round2(valuationRows[0]?.value ?? 0),
      lowStockItems,
    },
  };
  res.json(body);
});
