import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app, bearer, createUser, loginAs, PASSWORD, resetDb } from './helpers';
import { prisma } from '../src/db';

let admin: string;
let manager: string;
let cashier: string;
let cashier2: string;
let productId: string;

const pay = (amount: number) => ({ method: 'cash', amount });

async function secondCashier() {
  await prisma.user.create({
    data: { email: 'cashier2@test.local', name: 'cashier2', role: 'cashier', passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
  const res = await request(app).post('/api/auth/login').send({ email: 'cashier2@test.local', password: PASSWORD });
  return res.body.accessToken as string;
}

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
  cashier2 = await secondCashier();
  const p = await request(app)
    .post('/api/products')
    .set(bearer(manager))
    .send({ sku: 'SEC-1', name: 'Widget', price: 10, cost: 4, wholesalePrice: 8, openingQty: 50 });
  expect(p.status).toBe(201);
  productId = p.body.id;
});

describe('idempotency (per cashier, payload-aware)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    idempotencyKey: 'idem-key-0001',
    items: [{ productId, qty: 1 }],
    payment: pay(10),
    ...over,
  });

  it('replays the same payload with 200 and the same sale', async () => {
    const a = await request(app).post('/api/sales').set(bearer(cashier)).send(body());
    const b = await request(app).post('/api/sales').set(bearer(cashier)).send(body());
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.idempotentReplay).toBe(true);
    expect(await prisma.sale.count()).toBe(1);
  });

  it('treats item order as irrelevant to the fingerprint', async () => {
    const p2 = await request(app)
      .post('/api/products')
      .set(bearer(manager))
      .send({ sku: 'SEC-2', name: 'Other', price: 5, openingQty: 10 });
    const items = [{ productId, qty: 1 }, { productId: p2.body.id, qty: 2 }];
    const a = await request(app).post('/api/sales').set(bearer(cashier)).send(body({ items, payment: pay(50) }));
    const b = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send(body({ items: [...items].reverse(), payment: pay(50) }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });

  it('rejects the same key with a different payload (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    await request(app).post('/api/sales').set(bearer(cashier)).send(body());
    const qty = await request(app).post('/api/sales').set(bearer(cashier)).send(body({ items: [{ productId, qty: 2 }], payment: pay(20) }));
    expect(qty.status).toBe(409);
    expect(qty.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const amt = await request(app).post('/api/sales').set(bearer(cashier)).send(body({ payment: pay(15) }));
    expect(amt.status).toBe(409);
    expect(amt.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.sale.count()).toBe(1);
  });

  it('never returns another cashier\'s sale for the same key', async () => {
    const mine = await request(app).post('/api/sales').set(bearer(cashier)).send(body());
    const theirs = await request(app).post('/api/sales').set(bearer(cashier2)).send(body());
    // Keys are scoped per cashier: the second user gets their own, independent sale.
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.body.cashierId).not.toBe(mine.body.cashierId);
    expect(theirs.body.idempotentReplay).toBe(false);
    expect(await prisma.sale.count()).toBe(2);
  });

  it('accepts same-cashier replays of legacy rows without a fingerprint', async () => {
    const a = await request(app).post('/api/sales').set(bearer(cashier)).send(body());
    await prisma.sale.update({ where: { id: a.body.id }, data: { idempotencyFingerprint: null } });
    const b = await request(app).post('/api/sales').set(bearer(cashier)).send(body({ payment: pay(99) }));
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });

  it('concurrent identical requests produce exactly one sale', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/sales').set(bearer(cashier)).send(body())),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.sale.count()).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stockQty).toBe(49);
  });
});

describe('input bounds', () => {
  it('rejects oversize quantities and money with 400', async () => {
    const sale = (over: Record<string, unknown>) =>
      request(app).post('/api/sales').set(bearer(cashier)).send({ idempotencyKey: 'bound-key-01', items: [{ productId, qty: 1 }], payment: pay(10), ...over });
    expect((await sale({ items: [{ productId, qty: 100_001 }] })).status).toBe(400);
    expect((await sale({ items: [{ productId, qty: 2_147_483_647 }] })).status).toBe(400);
    expect((await sale({ payment: pay(10_000_000) })).status).toBe(400);
    expect((await sale({ items: [{ productId, qty: 1, discount: { type: 'fixed', value: 1e12 } }] })).status).toBe(400);

    const prod = (over: Record<string, unknown>) =>
      request(app).post('/api/products').set(bearer(manager)).send({ sku: 'B-1', name: 'B', price: 1, ...over });
    expect((await prod({ price: 1e12 })).status).toBe(400);
    expect((await prod({ cost: 10_000_000 })).status).toBe(400);
    expect((await prod({ wholesalePrice: 1e10 })).status).toBe(400);
    expect((await prod({ openingQty: 100_001 })).status).toBe(400);

    const inv = (path: string, b: Record<string, unknown>) =>
      request(app).post(`/api/inventory/${path}`).set(bearer(manager)).send({ productId, ...b });
    expect((await inv('receipts', { qty: 100_001 })).status).toBe(400);
    expect((await inv('receipts', { qty: 1, unitCost: 1e10 })).status).toBe(400);
    expect((await inv('opening-balance', { qty: 100_001 })).status).toBe(400);
    expect((await inv('adjustments', { qtyChange: 100_001, reason: 'x' })).status).toBe(400);
    expect((await inv('adjustments', { qtyChange: -100_001, reason: 'x' })).status).toBe(400);
    expect((await inv('write-offs', { type: 'waste', qty: 100_001, reason: 'x' })).status).toBe(400);
  });

  it('accepts values at the boundary', async () => {
    const r = await request(app)
      .post('/api/inventory/adjustments')
      .set(bearer(manager))
      .send({ productId, qtyChange: 100_000, reason: 'boundary' });
    expect(r.status).toBe(201);
  });

  it('returns a clean 400 (not 500) when stock would overflow int32', async () => {
    await prisma.product.update({ where: { id: productId }, data: { stockQty: 2_147_483_000 } });
    const r = await request(app)
      .post('/api/inventory/receipts')
      .set(bearer(manager))
      .send({ productId, qty: 100_000 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('BAD_REQUEST');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stockQty).toBe(2_147_483_000);
  });
});

describe('stale tokens', () => {
  it('rejects a still-valid token once the user is deactivated', async () => {
    expect((await request(app).get('/api/products').set(bearer(cashier))).status).toBe(200);
    await prisma.user.update({ where: { email: 'cashier@test.local' }, data: { active: false } });
    expect((await request(app).get('/api/products').set(bearer(cashier))).status).toBe(401);
    expect((await request(app).get('/api/dashboard').set(bearer(cashier))).status).toBe(401);
  });

  it('rejects a token for a deleted user', async () => {
    await prisma.user.delete({ where: { email: 'cashier2@test.local' } });
    expect((await request(app).get('/api/products').set(bearer(cashier2))).status).toBe(401);
  });

  it('uses the DB role: a demoted manager loses void access', async () => {
    const sale = await request(app).post('/api/sales').set(bearer(cashier)).send({
      idempotencyKey: 'void-key-0001', items: [{ productId, qty: 1 }], payment: pay(10),
    });
    await prisma.user.update({ where: { email: 'manager@test.local' }, data: { role: 'cashier' } });
    const r = await request(app).post(`/api/sales/${sale.body.id}/void`).set(bearer(manager)).send({ reason: 'x' });
    expect(r.status).toBe(403);
  });

  it('uses the DB role: a promoted cashier gains manager access', async () => {
    await prisma.user.update({ where: { email: 'cashier@test.local' }, data: { role: 'manager' } });
    expect((await request(app).get('/api/inventory/stock').set(bearer(cashier))).status).toBe(200);
  });
});

describe('cashier cost visibility', () => {
  it('strips cost and wholesalePrice for cashiers but not managers', async () => {
    const list = await request(app).get('/api/products').set(bearer(cashier));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0]).not.toHaveProperty('cost');
    expect(list.body.items[0]).not.toHaveProperty('wholesalePrice');
    expect(list.body.items[0].price).toBe(10);
    expect(list.body.items[0].stockQty).toBe(50);

    const one = await request(app).get(`/api/products/${productId}`).set(bearer(cashier));
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty('cost');
    expect(one.body).not.toHaveProperty('wholesalePrice');

    for (const t of [manager, admin]) {
      const m = await request(app).get(`/api/products/${productId}`).set(bearer(t));
      expect(m.body.cost).toBe(4);
      expect(m.body.wholesalePrice).toBe(8);
    }
  });

  it('strips unitCost from sale, receipt and list responses for cashiers but not managers', async () => {
    const created = await request(app).post('/api/sales').set(bearer(cashier)).send({
      idempotencyKey: 'cost-key-0001', items: [{ productId, qty: 1 }], payment: pay(10),
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const replay = await request(app).post('/api/sales').set(bearer(cashier)).send({
      idempotencyKey: 'cost-key-0001', items: [{ productId, qty: 1 }], payment: pay(10),
    });
    const one = await request(app).get(`/api/sales/${id}`).set(bearer(cashier));
    const rcpt = await request(app).get(`/api/sales/${id}/receipt`).set(bearer(cashier));
    const list = await request(app).get('/api/sales').set(bearer(cashier));
    for (const r of [created, replay, one, rcpt, list]) {
      expect(r.status).toBeLessThan(300);
      expect(JSON.stringify(r.body)).not.toMatch(/unitCost/i);
    }
    expect(one.body.items[0].qty).toBe(1);

    const m = await request(app).get(`/api/sales/${id}`).set(bearer(manager));
    expect(m.body.items[0].unitCost).toBeDefined();
    const mr = await request(app).get(`/api/sales/${id}/receipt`).set(bearer(manager));
    expect(mr.body.items[0].unitCost).toBeDefined();
  });

  it('blocks cashiers from inventory stock and movements, allows managers', async () => {
    expect((await request(app).get('/api/inventory/stock').set(bearer(cashier))).status).toBe(403);
    expect((await request(app).get('/api/inventory/movements').set(bearer(cashier))).status).toBe(403);
    expect((await request(app).get('/api/inventory/stock').set(bearer(manager))).status).toBe(200);
    expect((await request(app).get('/api/inventory/movements').set(bearer(manager))).status).toBe(200);
  });

  it('keeps the dashboard available to cashiers with own scope', async () => {
    const r = await request(app).get('/api/dashboard').set(bearer(cashier));
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('own');
    expect(r.body.current.grossProfit).toBeNull();
  });
});
