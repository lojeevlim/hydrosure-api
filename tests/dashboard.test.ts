import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, bearer, createUser, loginAs, resetDb } from './helpers';
import { prisma } from '../src/db';

let admin: string;
let manager: string;
let cashier: string;
let keySeq = 0;

async function makeProduct(over: Record<string, unknown>) {
  const res = await request(app).post('/api/products').set(bearer(manager)).send(over);
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function sell(token: string, productId: string, qty: number, payment: Record<string, unknown>) {
  const res = await request(app)
    .post('/api/sales')
    .set(bearer(token))
    .send({ idempotencyKey: `dash-key-${String(++keySeq).padStart(6, '0')}`, items: [{ productId, qty }], payment });
  expect(res.status).toBe(201);
  return res.body as { id: string; total: number };
}

const cash = (amount: number) => ({ method: 'cash', amount });
const hours = (h: number) => h * 3_600_000;
const query = (from: Date, to: Date) => `/api/dashboard?from=${from.toISOString()}&to=${to.toISOString()}&tz=UTC`;

beforeAll(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  await createUser('admin');
  await createUser('manager');
  await createUser('cashier');
  admin = (await loginAs('admin')).accessToken;
  manager = (await loginAs('manager')).accessToken;
  cashier = (await loginAs('cashier')).accessToken;
});

/**
 * A: price 10 cost 4 stock 100 -> after all sales 94
 * B: price 20 cost 12 stock 3 reorder 5 -> sells 1 -> 2 (low)
 * C: stock 0 (out), D: archived
 * Current period (last 24h): cashier A x3 cash 30, cashier B x1 card 20, manager A x2 cash 20, a voided A x5.
 * Previous period: cashier A x1 = 10 (backdated 36h).
 */
async function seed() {
  const a = await makeProduct({ sku: 'A', name: 'Alpha', price: 10, cost: 4, openingQty: 100, reorderLevel: 5 });
  const b = await makeProduct({ sku: 'B', name: 'Bravo', price: 20, cost: 12, openingQty: 3, reorderLevel: 5 });
  await makeProduct({ sku: 'C', name: 'Charlie', price: 5, cost: 1, openingQty: 0, reorderLevel: 2 });
  const d = await makeProduct({ sku: 'D', name: 'Delta', price: 5, cost: 1, openingQty: 50 });
  await request(app).post(`/api/products/${d.id}/archive`).set(bearer(manager));

  await sell(cashier, a.id, 3, cash(30));
  await sell(cashier, b.id, 1, { method: 'card', amount: 20, externalRef: 'TERM-1' });
  await sell(manager, a.id, 2, cash(20));
  const voided = await sell(manager, a.id, 5, cash(50));
  const v = await request(app).post(`/api/sales/${voided.id}/void`).set(bearer(manager)).send({ reason: 'test' });
  expect(v.status).toBe(200);
  const old = await sell(cashier, a.id, 1, cash(10));
  await prisma.sale.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - hours(36)) } });
}

describe('GET /api/dashboard', () => {
  it('requires authentication and validates the query', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
    const now = new Date();
    const earlier = new Date(now.getTime() - hours(1));
    expect((await request(app).get(query(now, earlier)).set(bearer(admin))).status).toBe(400);
    expect((await request(app).get('/api/dashboard?from=yesterday').set(bearer(admin))).status).toBe(400);
    expect((await request(app).get('/api/dashboard?tz=Not/AZone').set(bearer(admin))).status).toBe(400);
    expect((await request(app).get('/api/dashboard?from=2020-01-01&to=2026-01-01').set(bearer(admin))).status).toBe(400);
    expect((await request(app).get('/api/dashboard').set(bearer(admin))).status).toBe(200);
  });

  it('returns correct aggregates, excluding voided sales, with previous-period comparison', async () => {
    await seed();
    const to = new Date(Date.now() + 60_000);
    const from = new Date(to.getTime() - hours(24));
    const res = await request(app).get(query(from, to)).set(bearer(manager));
    expect(res.status).toBe(200);
    const d = res.body;

    expect(d.scope).toBe('all');
    expect(d.current).toEqual({ totalSales: 70, transactionCount: 3, grossProfit: 38, marginPct: 54.29 });
    expect(d.previous).toEqual({ totalSales: 10, transactionCount: 1, grossProfit: 6, marginPct: 60 });
    expect(d.change).toEqual({ totalSalesPct: 600, transactionCountPct: 200, grossProfitPct: 533.33 });
    expect(new Date(d.previousRange.to).getTime()).toBe(from.getTime());
    expect(new Date(d.previousRange.from).getTime()).toBe(from.getTime() - (to.getTime() - from.getTime()));

    expect(d.trend.length).toBeGreaterThanOrEqual(2);
    expect(d.trend.reduce((s: number, t: { total: number }) => s + t.total, 0)).toBe(70);
    expect(d.trend.reduce((s: number, t: { count: number }) => s + t.count, 0)).toBe(3);

    expect(d.topProducts).toEqual([
      { productId: expect.any(String), sku: 'A', name: 'Alpha', qty: 5, revenue: 50 },
      { productId: expect.any(String), sku: 'B', name: 'Bravo', qty: 1, revenue: 20 },
    ]);
    expect(d.recentTransactions).toHaveLength(3);
    expect(d.recentTransactions[0]).toMatchObject({ total: 20, cashierName: 'manager', methods: ['cash'] });
    expect(d.paymentBreakdown).toEqual([
      { method: 'cash', amount: 50, count: 2 },
      { method: 'card', amount: 20, count: 1 },
    ]);

    // 2 opening + 4 sales (incl. the voided one) + 1 void_return in the period; the backdated sale's movement is also "now".
    expect(d.recentMovements.length).toBeGreaterThan(0);
    expect(d.recentMovements.length).toBeLessThanOrEqual(10);
    expect(d.recentMovements.some((m: { type: string }) => m.type === 'void_return')).toBe(true);

    expect(d.inventory).toMatchObject({
      totalProducts: 4,
      activeSkus: 3,
      lowStockCount: 1,
      outOfStockCount: 1,
      valuation: 94 * 4 + 2 * 12,
    });
    expect(d.inventory.lowStockItems.map((i: { sku: string }) => i.sku)).toEqual(['C', 'B']);
  });

  it('gives zero/null figures and no previous-period change for an empty period', async () => {
    await seed();
    const to = new Date(Date.now() - hours(100));
    const from = new Date(to.getTime() - hours(24));
    const d = (await request(app).get(query(from, to)).set(bearer(admin))).body;
    expect(d.current).toEqual({ totalSales: 0, transactionCount: 0, grossProfit: 0, marginPct: null });
    expect(d.change).toEqual({ totalSalesPct: null, transactionCountPct: null, grossProfitPct: null });
    expect(d.topProducts).toEqual([]);
    expect(d.recentTransactions).toEqual([]);
    expect(d.paymentBreakdown).toEqual([]);
    expect(d.trend.every((t: { total: number }) => t.total === 0)).toBe(true);
  });

  it('shows cashiers only their own sales and hides profit, valuation and movements', async () => {
    await seed();
    const to = new Date(Date.now() + 60_000);
    const from = new Date(to.getTime() - hours(24));
    const d = (await request(app).get(query(from, to)).set(bearer(cashier))).body;
    expect(d.scope).toBe('own');
    expect(d.current).toEqual({ totalSales: 50, transactionCount: 2, grossProfit: null, marginPct: null });
    expect(d.previous.totalSales).toBe(10);
    expect(d.change.totalSalesPct).toBe(400);
    expect(d.change.grossProfitPct).toBeNull();
    expect(d.recentTransactions.every((t: { cashierName: string }) => t.cashierName === 'cashier')).toBe(true);
    expect(d.paymentBreakdown).toEqual([
      { method: 'cash', amount: 30, count: 1 },
      { method: 'card', amount: 20, count: 1 },
    ]);
    expect(d.recentMovements).toEqual([]);
    expect(d.inventory.valuation).toBeNull();
    expect(d.inventory.lowStockCount).toBe(1);
  });

  it('accepts date-only bounds and treats a date-only "to" as the whole day', async () => {
    await seed();
    const today = new Date().toISOString().slice(0, 10);
    const d = (await request(app).get(`/api/dashboard?from=${today}&to=${today}&tz=UTC`).set(bearer(admin))).body;
    expect(d.current.totalSales).toBe(70);
    expect(d.trend).toHaveLength(1);
  });
});
