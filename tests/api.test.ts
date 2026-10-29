import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, bearer, createUser, loginAs, resetDb } from './helpers';
import { prisma } from '../src/db';

let admin: string;
let manager: string;
let cashier: string;

async function makeProduct(over: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/products')
    .set(bearer(manager))
    .send({ sku: 'SKU-1', name: 'Widget', price: 10, cost: 4, openingQty: 5, ...over });
  expect(res.status).toBe(201);
  return res.body as { id: string; stockQty: number };
}

const pay = (amount: number) => ({ method: 'cash', amount });

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

describe('auth', () => {
  it('rejects bad credentials and unauthenticated access', async () => {
    const bad = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: 'nope' });
    expect(bad.status).toBe(401);
    expect((await request(app).get('/api/products')).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const first = await loginAs('cashier');
    const second = await request(app).post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);

    // Reusing the rotated token is treated as theft...
    const reuse = await request(app).post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    // ...and the legitimately issued successor is now dead too.
    const successor = await request(app).post('/api/auth/refresh').send({ refreshToken: second.body.refreshToken });
    expect(successor.status).toBe(401);
  });

  it('stores only hashed refresh tokens', async () => {
    const t = await loginAs('cashier');
    const rows = await prisma.refreshToken.findMany();
    expect(rows.some((r) => r.tokenHash === t.refreshToken)).toBe(false);
  });
});

describe('RBAC', () => {
  it('forbids cashiers from creating products, adjusting stock and voiding', async () => {
    const p = await request(app).post('/api/products').set(bearer(cashier)).send({ sku: 'X', name: 'X', price: 1 });
    expect(p.status).toBe(403);
    const adj = await request(app)
      .post('/api/inventory/adjustments')
      .set(bearer(cashier))
      .send({ productId: 'x', qtyChange: 1, reason: 'r' });
    expect(adj.status).toBe(403);
    const v = await request(app).post('/api/sales/abc/void').set(bearer(cashier)).send({ reason: 'x' });
    expect(v.status).toBe(403);
  });
});

describe('products', () => {
  it('rejects duplicate SKU and barcode', async () => {
    await makeProduct({ barcode: '123' });
    const dupSku = await request(app).post('/api/products').set(bearer(manager)).send({ sku: 'SKU-1', name: 'B', price: 1 });
    expect(dupSku.status).toBe(409);
    const dupBar = await request(app)
      .post('/api/products')
      .set(bearer(manager))
      .send({ sku: 'SKU-2', barcode: '123', name: 'B', price: 1 });
    expect(dupBar.status).toBe(409);
  });

  it('records an opening_balance movement and supports search + archive', async () => {
    const p = await makeProduct();
    expect(p.stockQty).toBe(5);
    const mv = await prisma.inventoryMovement.findMany({ where: { productId: p.id } });
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ type: 'opening_balance', qtyBefore: 0, qtyAfter: 5 });

    const found = await request(app).get('/api/products?search=widg').set(bearer(cashier));
    expect(found.body.total).toBe(1);
    expect(found.body.items[0].price).toBe(10);

    await request(app).post(`/api/products/${p.id}/archive`).set(bearer(manager)).expect(200);
    expect((await request(app).get('/api/products').set(bearer(cashier))).body.total).toBe(0);
  });

  it('validates input with zod', async () => {
    const r = await request(app).post('/api/products').set(bearer(manager)).send({ sku: '', price: -1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('inventory', () => {
  it('receipts, adjustments and write-offs write movements; negative stock is refused', async () => {
    const p = await makeProduct({ openingQty: 0 });
    await request(app).post('/api/inventory/receipts').set(bearer(manager)).send({ productId: p.id, qty: 10 }).expect(201);
    await request(app)
      .post('/api/inventory/write-offs')
      .set(bearer(manager))
      .send({ productId: p.id, type: 'damage', qty: 3, reason: 'dropped' })
      .expect(201);
    const over = await request(app)
      .post('/api/inventory/adjustments')
      .set(bearer(manager))
      .send({ productId: p.id, qtyChange: -50, reason: 'oops' });
    expect(over.status).toBe(409);
    const prod = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(prod.stockQty).toBe(7);
    const moves = await request(app).get(`/api/inventory/movements?productId=${p.id}`).set(bearer(manager));
    expect(moves.body.total).toBe(2);
    const low = await request(app).get('/api/inventory/stock?status=low').set(bearer(manager));
    expect(low.status).toBe(200);
  });
});

describe('sales', () => {
  it('checks out server-side priced, reduces stock with a movement row', async () => {
    const p = await makeProduct();
    const res = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send({
        idempotencyKey: 'key-00000001',
        // Client-supplied price must be ignored (strict totals come from the DB).
        items: [{ productId: p.id, qty: 2, price: 0.01 }],
        payment: pay(50),
      });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(20);
    expect(res.body.payments[0]).toMatchObject({ method: 'cash', changeGiven: 30, verified: true });
    expect(res.body.items[0]).toMatchObject({ unitPrice: 10 });
    expect(res.body.items[0]).not.toHaveProperty('unitCost'); // cashiers never see purchase cost

    const prod = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(prod.stockQty).toBe(3);
    const mv = await prisma.inventoryMovement.findFirstOrThrow({ where: { type: 'sale' } });
    expect(mv).toMatchObject({ qtyChange: -2, qtyBefore: 5, qtyAfter: 3, referenceId: res.body.id });
  });

  it('applies discounts and tax server-side', async () => {
    const tax = await prisma.taxCategory.create({ data: { name: 'VAT', rate: 12 } });
    const p = await makeProduct({ taxCategoryId: tax.id, price: 100 });
    const res = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send({
        idempotencyKey: 'key-00000002',
        items: [{ productId: p.id, qty: 1, discount: { type: 'percent', value: 10 } }],
        payment: pay(200),
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subtotal: 100, discountTotal: 10, taxTotal: 10.8, total: 100.8 });
  });

  it('returns the same sale for a repeated idempotency key without double-deducting', async () => {
    const p = await makeProduct();
    const body = { idempotencyKey: 'key-00000003', items: [{ productId: p.id, qty: 1 }], payment: pay(10) };
    const a = await request(app).post('/api/sales').set(bearer(cashier)).send(body);
    const b = await request(app).post('/api/sales').set(bearer(cashier)).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(await prisma.sale.count()).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(4);
  });

  it('handles concurrent identical checkouts as one sale', async () => {
    const p = await makeProduct();
    const body = { idempotencyKey: 'key-00000004', items: [{ productId: p.id, qty: 1 }], payment: pay(10) };
    const rs = await Promise.all([1, 2, 3].map(() => request(app).post('/api/sales').set(bearer(cashier)).send(body)));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(4);
  });

  it('rejects insufficient stock and leaves no sale or movement behind', async () => {
    const p = await makeProduct();
    const res = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send({ idempotencyKey: 'key-00000005', items: [{ productId: p.id, qty: 6 }], payment: pay(100) });
    expect(res.status).toBe(409);
    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { type: 'sale' } })).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(5);
  });

  it('rejects insufficient cash and records card as unverified external reference', async () => {
    const p = await makeProduct();
    const short = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send({ idempotencyKey: 'key-00000006', items: [{ productId: p.id, qty: 1 }], payment: pay(5) });
    expect(short.status).toBe(400);
    const card = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send({
        idempotencyKey: 'key-00000007',
        items: [{ productId: p.id, qty: 1 }],
        payment: { method: 'card', amount: 10, externalRef: 'TERM-123' },
      });
    expect(card.status).toBe(201);
    expect(card.body.payments[0]).toMatchObject({ method: 'card', status: 'unverified', verified: false, externalRef: 'TERM-123' });
  });

  it('voids a sale: restores stock via movements and writes an audit log; second void is 409', async () => {
    const p = await makeProduct();
    const sale = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send({ idempotencyKey: 'key-00000008', items: [{ productId: p.id, qty: 2 }], payment: pay(20) });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(3);

    const v = await request(app).post(`/api/sales/${sale.body.id}/void`).set(bearer(manager)).send({ reason: 'customer return' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(5);
    const ret = await prisma.inventoryMovement.findFirstOrThrow({ where: { type: 'void_return' } });
    expect(ret).toMatchObject({ qtyChange: 2, qtyBefore: 3, qtyAfter: 5, referenceId: sale.body.id });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'sale.void' } });
    expect(audit).toMatchObject({ entityType: 'Sale', entityId: sale.body.id });

    const again = await request(app).post(`/api/sales/${sale.body.id}/void`).set(bearer(admin)).send({ reason: 'again' });
    expect(again.status).toBe(409);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(5);
  });

  it('serves a receipt and lets cashiers see only their own sales', async () => {
    const p = await makeProduct();
    const sale = await request(app)
      .post('/api/sales')
      .set(bearer(manager))
      .send({ idempotencyKey: 'key-00000009', items: [{ productId: p.id, qty: 1 }], payment: pay(10) });
    const r = await request(app).get(`/api/sales/${sale.body.id}/receipt`).set(bearer(manager));
    expect(r.status).toBe(200);
    expect(r.body.receiptNo).toMatch(/^R-\d{6}$/);
    expect((await request(app).get(`/api/sales/${sale.body.id}`).set(bearer(cashier))).status).toBe(404);
  });
});

describe('held carts', () => {
  it('holds and resumes a cart (resume removes it)', async () => {
    const p = await makeProduct();
    const h = await request(app)
      .post('/api/held-carts')
      .set(bearer(cashier))
      .send({ label: 'Table 4', items: [{ productId: p.id, qty: 2 }] });
    expect(h.status).toBe(201);
    expect((await request(app).get('/api/held-carts').set(bearer(cashier))).body).toHaveLength(1);
    const r = await request(app).post(`/api/held-carts/${h.body.id}/resume`).set(bearer(cashier));
    expect(r.status).toBe(200);
    expect(r.body.items[0].qty).toBe(2);
    expect((await request(app).post(`/api/held-carts/${h.body.id}/resume`).set(bearer(cashier))).status).toBe(404);
  });
});

describe('master data', () => {
  it('CRUDs categories and blocks deleting one in use', async () => {
    const c = await request(app).post('/api/categories').set(bearer(manager)).send({ name: 'Drinks' });
    expect(c.status).toBe(201);
    await makeProduct({ categoryId: c.body.id });
    const del = await request(app).delete(`/api/categories/${c.body.id}`).set(bearer(manager));
    expect(del.status).toBe(409);
    expect((await request(app).post('/api/categories').set(bearer(cashier)).send({ name: 'X' })).status).toBe(403);
  });
});

describe('product extra fields', () => {
  const bad = (body: Record<string, unknown>) =>
    request(app).post('/api/products').set(bearer(manager)).send({ sku: 'BAD', name: 'Bad', price: 1, ...body });

  it('stores and returns wholesalePrice, maxStock, expirationDate and imageUrl', async () => {
    const p = await makeProduct({
      wholesalePrice: 8.5,
      reorderLevel: 2,
      maxStock: 20,
      expirationDate: '2027-03-31',
      imageUrl: 'https://example.com/a.png',
    });
    const got = (await request(app).get(`/api/products/${p.id}`).set(bearer(manager))).body;
    expect(Number(got.wholesalePrice)).toBe(8.5);
    expect(got.maxStock).toBe(20);
    expect(got.expirationDate.slice(0, 10)).toBe('2027-03-31');
    expect(got.imageUrl).toBe('https://example.com/a.png');
  });

  it('rejects invalid values on create', async () => {
    for (const body of [
      { wholesalePrice: -1 },
      { reorderLevel: 10, maxStock: 5 },
      { expirationDate: '2027-02-31' },
      { expirationDate: 'tomorrow' },
      { imageUrl: 'javascript:alert(1)' },
      { imageUrl: 'data:image/png;base64,AAAA' },
      { imageUrl: 'ftp://example.com/a.png' },
      { imageUrl: 'not a url' },
      { imageUrl: `https://example.com/${'a'.repeat(2100)}` },
    ]) {
      const r = await bad(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('checks maxStock against the stored reorder level on update', async () => {
    const p = await makeProduct({ reorderLevel: 5, maxStock: 10 });
    const patch = (b: Record<string, unknown>) =>
      request(app).patch(`/api/products/${p.id}`).set(bearer(manager)).send(b as object);
    expect((await patch({ maxStock: 3 })).status).toBe(400);
    expect((await patch({ reorderLevel: 11 })).status).toBe(400);
    expect((await patch({ imageUrl: 'javascript:alert(1)' })).status).toBe(400);
    const ok = await patch({ maxStock: null, expirationDate: null });
    expect(ok.status).toBe(200);
    expect(ok.body.maxStock).toBeNull();
    // A partial PATCH must not reset unrelated fields.
    expect(ok.body.reorderLevel).toBe(5);
    expect(Number(ok.body.cost)).toBe(4);
  });
});

describe('product supplier filter', () => {
  it('lists only products of the given supplier', async () => {
    const s1 = await request(app).post('/api/suppliers').set(bearer(manager)).send({ name: 'S1' });
    const s2 = await request(app).post('/api/suppliers').set(bearer(manager)).send({ name: 'S2' });
    await makeProduct({ sku: 'A', supplierId: s1.body.id });
    await makeProduct({ sku: 'B', supplierId: s2.body.id });
    await makeProduct({ sku: 'C' });
    const r = await request(app).get(`/api/products?supplierId=${s1.body.id}`).set(bearer(cashier));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { sku: string }) => i.sku)).toEqual(['A']);
  });
});

describe('tax categories', () => {
  it('CRUDs with validation, RBAC, and blocks deleting one in use', async () => {
    const post = (b: object, t = manager) => request(app).post('/api/tax-categories').set(bearer(t)).send(b);
    expect((await post({ name: 'Bad', rate: 101 })).status).toBe(400);
    expect((await post({ name: 'Bad', rate: -1 })).status).toBe(400);
    expect((await post({ name: 'Bad', rate: 1.234 })).status).toBe(400);
    expect((await post({ name: 'VAT', rate: 12 }, cashier)).status).toBe(403);
    const c = await post({ name: 'VAT', rate: 12 }, admin);
    expect(c.status).toBe(201);
    expect((await post({ name: 'VAT', rate: 5 })).status).toBe(409);
    const list = await request(app).get('/api/tax-categories').set(bearer(cashier));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const up = await request(app).patch(`/api/tax-categories/${c.body.id}`).set(bearer(manager)).send({ rate: 10 });
    expect(Number(up.body.rate)).toBe(10);

    await makeProduct({ taxCategoryId: c.body.id });
    const del = await request(app).delete(`/api/tax-categories/${c.body.id}`).set(bearer(manager));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('IN_USE');

    const unused = await post({ name: 'Zero', rate: 0 });
    expect((await request(app).delete(`/api/tax-categories/${unused.body.id}`).set(bearer(manager))).status).toBe(204);
  });
});

describe('movement date filters', () => {
  it('filters by inclusive from/to and rejects bad or reversed ranges', async () => {
    const p = await makeProduct({ openingQty: 0 });
    await request(app).post('/api/inventory/receipts').set(bearer(manager)).send({ productId: p.id, qty: 3 }).expect(201);
    await request(app).post('/api/inventory/receipts').set(bearer(manager)).send({ productId: p.id, qty: 4 }).expect(201);
    const rows = await prisma.inventoryMovement.findMany({ orderBy: { createdAt: 'asc' } });
    await prisma.inventoryMovement.update({ where: { id: rows[0].id }, data: { createdAt: new Date('2026-01-10T12:00:00Z') } });
    await prisma.inventoryMovement.update({ where: { id: rows[1].id }, data: { createdAt: new Date('2026-01-20T23:30:00Z') } });
    const q = async (qs: string) =>
      (await request(app).get(`/api/inventory/movements?${qs}`).set(bearer(manager))).body.total as number;

    expect(await q('')).toBe(2);
    expect(await q('from=2026-01-15')).toBe(1);
    expect(await q('to=2026-01-15')).toBe(1);
    expect(await q('to=2026-01-20')).toBe(2); // whole "to" day is included
    expect(await q('from=2026-01-10&to=2026-01-10')).toBe(1);
    expect(await q('from=2026-02-01')).toBe(0);
    expect(await q('from=2026-01-20T23:00:00Z&to=2026-01-20T23:59:00Z')).toBe(1);
    for (const qs of ['from=garbage', 'to=2026-13-40', 'from=2026-02-01&to=2026-01-01']) {
      expect((await request(app).get(`/api/inventory/movements?${qs}`).set(bearer(manager))).status, qs).toBe(400);
    }
  });
});

describe('tax applied at checkout', () => {
  it('uses the product tax category rate', async () => {
    const tc = await request(app).post('/api/tax-categories').set(bearer(manager)).send({ name: 'VAT12', rate: 12 });
    const p = await makeProduct({ taxCategoryId: tc.body.id, price: 100, openingQty: 5 });
    const sale = await request(app)
      .post('/api/sales')
      .set(bearer(cashier))
      .send({ idempotencyKey: 'key-tax-0001', items: [{ productId: p.id, qty: 1 }], payment: pay(500) });
    expect(sale.status).toBe(201);
    expect(sale.body).toMatchObject({ taxTotal: 12, total: 112 });
  });
});
