/**
 * Optional demo data so the dashboard charts have something to show.
 *
 *   npm run seed:demo                 create / top up demo data (idempotent)
 *   npm run seed:demo:clear           delete ONLY demo data
 *   npm run seed:demo:clear -- --dry-run print what clear would delete
 *
 * Everything created is identifiable: SKU prefix DEMO-, names starting "Demo ",
 * sale idempotency keys demo-<YYYY-MM-DD>-<n>. Never runs in production.
 * Pricing mirrors services/salesService.ts (integer cents, tax-exclusive) and
 * stock chains mirror inventoryService.applyMovement (qtyBefore/qtyAfter).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type MovementType } from '@prisma/client';

const prisma = new PrismaClient();

const DAYS = 30;
const KEY_PREFIX = 'demo-';
const SKU_PREFIX = 'DEMO-';
const TX_OPTS = { timeout: 120_000, maxWait: 20_000 };

const cents = (d: Prisma.Decimal | number) => Math.round(Number(d) * 100);
const money = (c: number) => new Prisma.Decimal(c).div(100);

// ---------- deterministic PRNG ----------
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- demo catalog ----------
interface DemoProduct {
  sku: string;
  name: string;
  category: string;
  brand: string;
  cost: number;
  price: number;
  taxed: boolean;
  reorder: number;
  /** Relative sales popularity. */
  weight: number;
  /** Stock at the end of the period (low / zero items are deliberate). */
  endStock: number;
  /** Mid-period receipts: days-ago and quantity. */
  receipts?: { daysAgo: number; qty: number }[];
  /** True when the end stock is a deliberate low/zero target (never on voided sales). */
  pinned?: boolean;
}
const B1 = 'Demo Fresh Co';
const B2 = 'Demo Pantry Foods';
const CAT_BEV = 'Demo Beverages';
const CAT_SNK = 'Demo Snacks';
const CAT_HH = 'Demo Household';
const PRODUCTS: DemoProduct[] = [
  { sku: 'DEMO-001', name: 'Demo Mineral Water 500ml', category: CAT_BEV, brand: B1, cost: 9, price: 15, taxed: false, reorder: 30, weight: 10, endStock: 90, receipts: [{ daysAgo: 16, qty: 150 }] },
  { sku: 'DEMO-002', name: 'Demo Iced Tea 350ml', category: CAT_BEV, brand: B1, cost: 14, price: 22, taxed: false, reorder: 20, weight: 7, endStock: 70 },
  { sku: 'DEMO-003', name: 'Demo Cola 1.5L', category: CAT_BEV, brand: B2, cost: 44, price: 55, taxed: true, reorder: 12, weight: 5, endStock: 45, receipts: [{ daysAgo: 10, qty: 60 }] },
  { sku: 'DEMO-004', name: 'Demo Instant Coffee 3in1', category: CAT_BEV, brand: B2, cost: 5.5, price: 8, taxed: false, reorder: 40, weight: 9, endStock: 160 },
  { sku: 'DEMO-005', name: 'Demo Potato Chips 60g', category: CAT_SNK, brand: B1, cost: 18, price: 26, taxed: true, reorder: 15, weight: 6, endStock: 6, pinned: true },
  { sku: 'DEMO-006', name: 'Demo Choco Biscuits', category: CAT_SNK, brand: B2, cost: 24, price: 32, taxed: true, reorder: 12, weight: 5, endStock: 55 },
  { sku: 'DEMO-007', name: 'Demo Salted Peanuts 100g', category: CAT_SNK, brand: B2, cost: 20, price: 28, taxed: true, reorder: 12, weight: 4, endStock: 48 },
  { sku: 'DEMO-008', name: 'Demo Instant Noodles', category: CAT_SNK, brand: B1, cost: 7, price: 12.5, taxed: false, reorder: 40, weight: 8, endStock: 130, receipts: [{ daysAgo: 20, qty: 120 }] },
  { sku: 'DEMO-009', name: 'Demo Dish Soap 250ml', category: CAT_HH, brand: B1, cost: 42, price: 58, taxed: true, reorder: 10, weight: 3, endStock: 4, pinned: true },
  { sku: 'DEMO-010', name: 'Demo Laundry Powder 1kg', category: CAT_HH, brand: B2, cost: 85, price: 120, taxed: true, reorder: 8, weight: 2, endStock: 35 },
  { sku: 'DEMO-011', name: 'Demo Tissue 4-roll', category: CAT_HH, brand: B1, cost: 48, price: 66, taxed: true, reorder: 8, weight: 3, endStock: 0, pinned: true },
  { sku: 'DEMO-012', name: 'Demo Laundry Bar', category: CAT_HH, brand: B2, cost: 14, price: 20, taxed: false, reorder: 15, weight: 4, endStock: 60 },
];
const DEMO_TAX_NAME = 'Demo VAT 12%';
const DEMO_UNIT_NAME = 'Demo Piece';
const REASONS = ['Demo: customer changed mind', 'Demo: wrong item scanned', 'Demo: duplicate transaction'];

// ---------- helpers ----------
const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (base: Date, daysBack: number, h: number, m = 0, s = 0) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() - daysBack, h, m, s);

function guardProduction() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run demo seeding with NODE_ENV=production.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (expected in apps/api/.env).');
    process.exit(1);
  }
}

// ---------- planning ----------
interface PlannedLine {
  sku: string;
  qty: number;
  discount?: { type: 'percent' | 'fixed'; value: number };
}
interface PlannedSale {
  key: string;
  t: Date;
  lines: PlannedLine[];
  method: 'cash' | 'card' | 'ewallet';
  refDigits: number;
  tenderRoundUp: number;
  voidAt: Date | null;
  voidReason: string;
}

function planSales(today: Date, now: Date): PlannedSale[] {
  const g = mulberry32(hashStr('demo-global'));
  const slow = new Set<number>();
  while (slow.size < 3) slow.add(2 + Math.floor(g() * (DAYS - 3)));
  const totalWeight = PRODUCTS.reduce((a, p) => a + p.weight, 0);
  const dowFactor = [1.2, 0.85, 0.95, 0.95, 1.0, 1.15, 1.35]; // Sun..Sat
  const out: PlannedSale[] = [];

  for (let i = 0; i < DAYS; i++) {
    const back = DAYS - 1 - i;
    const day = at(today, back, 0);
    const key = dateKey(day);
    const r = mulberry32(hashStr(`demo-${key}`));
    const base = 7 + 7 * (i / (DAYS - 1));
    const noise = (r() - 0.5) * 4;
    let count = Math.round(base * dowFactor[day.getDay()]! + noise);
    if (slow.has(i)) count = 4 + Math.floor(r() * 2);
    else r();
    count = Math.max(4, Math.min(20, count));

    // Times (bell-shaped inside 08:00-21:00), sorted so n ascends with time.
    const times: Date[] = [];
    for (let n = 0; n < count; n++) {
      const mins = 480 + Math.floor(((r() + r()) / 2) * 780);
      times.push(at(today, back, Math.floor(mins / 60), mins % 60, Math.floor(r() * 60)));
    }
    times.sort((a, b) => a.getTime() - b.getTime());

    times.forEach((t, idx) => {
      // Always consume the same randoms regardless of `now`, so output is stable.
      const lr = r();
      const nLines = lr < 0.35 ? 1 : lr < 0.7 ? 2 : lr < 0.9 ? 3 : 4;
      const picks: string[] = [];
      while (picks.length < nLines) {
        let x = r() * totalWeight;
        let chosen = PRODUCTS[0]!;
        for (const p of PRODUCTS) {
          x -= p.weight;
          if (x <= 0) {
            chosen = p;
            break;
          }
        }
        if (!picks.includes(chosen.sku)) picks.push(chosen.sku);
      }
      const lines: PlannedLine[] = picks.map((sku) => {
        const qr = r();
        const qty = qr < 0.6 ? 1 : qr < 0.88 ? 2 : 3;
        const line: PlannedLine = { sku, qty };
        const dr = r();
        const dv = r();
        if (dr < 0.12) line.discount = dv < 0.5 ? { type: 'percent', value: dv < 0.25 ? 5 : 10 } : { type: 'fixed', value: dv < 0.75 ? 2 : 5 };
        return line;
      });
      const pr = r();
      const method = pr < 0.6 ? 'cash' : pr < 0.85 ? 'card' : 'ewallet';
      const refDigits = 100000 + Math.floor(r() * 900000);
      const tenderRoundUp = r() < 0.2 ? 1 : [5000, 10000, 5000][Math.floor(r() * 3)]!;
      const wantVoid = r() < 0.02;
      const voidAfterMin = 10 + Math.floor(r() * 110);
      const voidReason = REASONS[Math.floor(r() * REASONS.length)]!;

      if (t.getTime() > now.getTime()) return; // never create future-dated sales
      let finalLines = lines;
      let voidAt: Date | null = null;
      if (wantVoid) {
        const cand = new Date(t.getTime() + voidAfterMin * 60_000);
        if (cand.getTime() <= now.getTime()) {
          voidAt = cand;
          // Keep deliberate low/zero-stock products off voided sales so their end stock stays exact.
          finalLines = lines.filter((l) => !PRODUCTS.find((p) => p.sku === l.sku)!.pinned);
          if (finalLines.length === 0) finalLines = [{ sku: 'DEMO-001', qty: 1 }];
        }
      }
      out.push({ key: `${KEY_PREFIX}${key}-${idx + 1}`, t, lines: finalLines, method, refDigits, tenderRoundUp, voidAt, voidReason });
    });
  }
  return out;
}

interface MoveDraft {
  sku: string;
  t: Date;
  seq: number;
  type: MovementType;
  delta: number;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
}

// ---------- seed ----------
async function seed() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();

  await prisma.$transaction(async (tx) => {
    const admin =
      (await tx.user.findUnique({ where: { email } })) ?? (await tx.user.findFirst({ where: { role: 'admin', active: true }, orderBy: { createdAt: 'asc' } }));
    if (!admin) throw new Error('No admin user found. Run `npm run seed` first.');

    const created = { categories: 0, brands: 0, products: 0, taxCategory: 0, unit: 0 };
    const findOrCreate = async <T>(find: () => Promise<T | null>, create: () => Promise<T>, k: keyof typeof created) => {
      const f = await find();
      if (f) return f;
      created[k]++;
      return create();
    };

    const unit = await findOrCreate(
      async () => (await tx.unit.findUnique({ where: { name: 'Piece' } })) ?? (await tx.unit.findUnique({ where: { name: DEMO_UNIT_NAME } })),
      () => tx.unit.create({ data: { name: DEMO_UNIT_NAME, abbreviation: 'pc' } }),
      'unit',
    );
    const tax = await findOrCreate(
      async () =>
        (await tx.taxCategory.findUnique({ where: { name: 'VAT 12%' } })) ?? (await tx.taxCategory.findUnique({ where: { name: DEMO_TAX_NAME } })),
      () => tx.taxCategory.create({ data: { name: DEMO_TAX_NAME, rate: 12 } }),
      'taxCategory',
    );
    const catId = new Map<string, string>();
    for (const name of [CAT_BEV, CAT_SNK, CAT_HH])
      catId.set(name, (await findOrCreate(() => tx.category.findUnique({ where: { name } }), () => tx.category.create({ data: { name } }), 'categories')).id);
    const brandId = new Map<string, string>();
    for (const name of [B1, B2])
      brandId.set(name, (await findOrCreate(() => tx.brand.findUnique({ where: { name } }), () => tx.brand.create({ data: { name } }), 'brands')).id);

    // Products (by SKU).
    const prodBySku = new Map<string, { id: string; price: Prisma.Decimal; cost: Prisma.Decimal; name: string; taxRate: number; stockQty: number; hasMovements: boolean }>();
    for (const p of PRODUCTS) {
      let row = await tx.product.findUnique({ where: { sku: p.sku }, include: { taxCategory: true } });
      if (!row) {
        created.products++;
        row = await tx.product.create({
          data: {
            sku: p.sku, name: p.name, categoryId: catId.get(p.category)!, brandId: brandId.get(p.brand)!, unitId: unit.id,
            taxCategoryId: p.taxed ? tax.id : null, cost: p.cost, price: p.price, reorderLevel: p.reorder, stockQty: 0,
          },
          include: { taxCategory: true },
        });
      }
      const hasMovements = (await tx.inventoryMovement.count({ where: { productId: row.id } })) > 0;
      prodBySku.set(p.sku, {
        id: row.id, price: row.price, cost: row.cost, name: row.name,
        taxRate: row.taxCategory ? Number(row.taxCategory.rate) : 0, stockQty: row.stockQty, hasMovements,
      });
    }

    const existingKeys = new Set(
      (await tx.sale.findMany({ where: { idempotencyKey: { startsWith: KEY_PREFIX } }, select: { idempotencyKey: true } })).map((s) => s.idempotencyKey),
    );
    const fresh = existingKeys.size === 0 && [...prodBySku.values()].every((p) => !p.hasMovements);
    let planned = planSales(today, now);
    if (!fresh) planned = planned.filter((s) => !existingKeys.has(s.key));

    // Build sales + movement drafts in chronological order.
    const running = new Map([...prodBySku].map(([sku, p]) => [sku, p.stockQty]));
    const saleRows: Prisma.SaleCreateManyInput[] = [];
    const itemRows: Prisma.SaleItemCreateManyInput[] = [];
    const payRows: Prisma.PaymentCreateManyInput[] = [];
    const auditRows: Prisma.AuditLogCreateManyInput[] = [];
    const drafts: MoveDraft[] = [];
    let seq = 0;
    let voided = 0;
    let totalCents = 0;
    let skippedIncremental = 0;

    for (const s of planned) {
      let lines = s.lines;
      if (!fresh) {
        lines = lines.filter((l) => (running.get(l.sku) ?? 0) >= l.qty);
        if (lines.length === 0) {
          skippedIncremental++;
          continue;
        }
        for (const l of lines) running.set(l.sku, running.get(l.sku)! - l.qty);
      }
      const saleId = randomUUID();
      let subtotal = 0, discountTotal = 0, taxTotal = 0;
      for (const l of lines) {
        const p = prodBySku.get(l.sku)!;
        const gross = cents(p.price) * l.qty;
        let disc = 0;
        if (l.discount) {
          disc = l.discount.type === 'percent' ? Math.round((gross * l.discount.value) / 100) : Math.round(l.discount.value * 100);
          if (disc > gross) disc = 0;
        }
        const net = gross - disc;
        const tax = Math.round((net * p.taxRate) / 100);
        subtotal += gross; discountTotal += disc; taxTotal += tax;
        itemRows.push({
          saleId, productId: p.id, sku: l.sku, name: p.name, qty: l.qty, unitPrice: p.price, unitCost: p.cost,
          taxRate: new Prisma.Decimal(p.taxRate), discountAmount: money(disc), lineSubtotal: money(net),
          taxAmount: money(tax), lineTotal: money(net + tax),
        });
        drafts.push({ sku: l.sku, t: s.t, seq: seq++, type: 'sale', delta: -l.qty, referenceType: 'sale', referenceId: saleId, reason: null });
        if (s.voidAt)
          drafts.push({ sku: l.sku, t: s.voidAt, seq: seq++, type: 'void_return', delta: l.qty, referenceType: 'sale', referenceId: saleId, reason: s.voidReason });
      }
      const total = subtotal - discountTotal + taxTotal;
      const isCash = s.method === 'cash';
      const tendered = isCash ? (s.tenderRoundUp === 1 ? total : Math.ceil(total / s.tenderRoundUp) * s.tenderRoundUp) : total;
      saleRows.push({
        id: saleId, idempotencyKey: s.key, customerId: null, cashierId: admin.id,
        subtotal: money(subtotal), discountTotal: money(discountTotal), taxTotal: money(taxTotal), total: money(total),
        createdAt: s.t, status: s.voidAt ? 'voided' : 'completed',
        ...(s.voidAt ? { voidedAt: s.voidAt, voidedById: admin.id, voidReason: s.voidReason } : {}),
      });
      payRows.push({
        saleId, method: s.method, status: s.voidAt ? 'voided' : isCash ? 'captured' : 'unverified', verified: isCash,
        amount: money(total), tendered: money(tendered), changeGiven: money(tendered - total),
        externalRef: isCash ? null : `DEMO-REF-${s.refDigits}`, createdAt: s.t,
      });
      if (s.voidAt) {
        voided++;
        auditRows.push({
          userId: admin.id, action: 'sale.void', entityType: 'Sale', entityId: saleId,
          metadata: { reason: s.voidReason, itemCount: lines.length }, createdAt: s.voidAt,
        });
      } else totalCents += total;
    }

    // Mid-period receipts + opening balances (fresh only).
    const openingAt = at(today, DAYS + 1, 7, 0);
    const openings = new Map<string, number>();
    if (fresh) {
      for (const p of PRODUCTS)
        for (const rc of p.receipts ?? [])
          drafts.push({ sku: p.sku, t: at(today, rc.daysAgo, 8, 15), seq: seq++, type: 'receipt', delta: rc.qty, referenceType: null, referenceId: null, reason: 'Demo restock' });
    }

    const bySku = new Map<string, MoveDraft[]>();
    for (const d of drafts) (bySku.get(d.sku) ?? bySku.set(d.sku, []).get(d.sku)!).push(d);
    const movementRows: Prisma.InventoryMovementCreateManyInput[] = [];
    const finalStock = new Map<string, number>();
    for (const p of PRODUCTS) {
      const list = (bySku.get(p.sku) ?? []).sort((a, b) => a.t.getTime() - b.t.getTime() || a.seq - b.seq);
      let qty = prodBySku.get(p.sku)!.stockQty;
      const id = prodBySku.get(p.sku)!.id;
      if (fresh) {
        let run = 0, min = 0;
        for (const d of list) { run += d.delta; min = Math.min(min, run); }
        const opening = Math.max(p.endStock - run, -min, 0);
        openings.set(p.sku, opening);
        movementRows.push({
          productId: id, type: 'opening_balance', qtyChange: opening, qtyBefore: 0, qtyAfter: opening,
          referenceType: 'demo', reason: 'Demo opening stock', userId: admin.id, createdAt: openingAt,
        });
        qty = opening;
      }
      for (const d of list) {
        const after = qty + d.delta;
        if (after < 0) throw new Error(`Internal error: negative stock for ${d.sku}`);
        movementRows.push({
          productId: id, type: d.type, qtyChange: d.delta, qtyBefore: qty, qtyAfter: after,
          referenceType: d.referenceType, referenceId: d.referenceId, reason: d.reason, userId: admin.id, createdAt: d.t,
        });
        qty = after;
      }
      finalStock.set(p.sku, qty);
    }

    console.log(`Mode: ${fresh ? 'fresh backfill' : 'incremental (only missing days / sales are added)'}`);
    console.log(`Window: ${dateKey(at(today, DAYS - 1, 0))} .. ${dateKey(today)} (${DAYS} days, local time)`);
    console.log(`Cashier: ${admin.email}`);
    console.log(`Will create: ${saleRows.length} sales (${voided} voided), ${itemRows.length} sale items, ${payRows.length} payments, ${movementRows.length} stock movements, ${auditRows.length} audit rows`);

    // Insert chronologically so receipt numbers (Sale.number) ascend with time.
    if (saleRows.length) {
      await tx.sale.createMany({ data: saleRows });
      await tx.saleItem.createMany({ data: itemRows });
      await tx.payment.createMany({ data: payRows });
      if (auditRows.length) await tx.auditLog.createMany({ data: auditRows });
    }
    if (movementRows.length) await tx.inventoryMovement.createMany({ data: movementRows });
    if (saleRows.length || fresh) {
      for (const p of PRODUCTS) await tx.product.update({ where: { id: prodBySku.get(p.sku)!.id }, data: { stockQty: finalStock.get(p.sku)! } });
    }

    console.log('Created:');
    console.log(`  categories ${created.categories}, brands ${created.brands}, products ${created.products}, tax categories ${created.taxCategory}, units ${created.unit}`);
    console.log(`  sales ${saleRows.length} (voided ${voided}), items ${itemRows.length}, payments ${payRows.length}, movements ${movementRows.length}, audit ${auditRows.length}`);
    console.log(`  completed sales value ${(totalCents / 100).toFixed(2)}`);
    if (skippedIncremental) console.log(`  skipped ${skippedIncremental} planned sales (insufficient stock in incremental mode)`);
    if (!saleRows.length && !created.products) console.log('Nothing to do: demo data already present (no duplicates created).');
  }, TX_OPTS);
}

// ---------- clear ----------
async function clear(dryRun: boolean) {
  await prisma.$transaction(async (tx) => {
    const sales = await tx.sale.findMany({ where: { idempotencyKey: { startsWith: KEY_PREFIX } }, select: { id: true } });
    const saleIds = sales.map((s) => s.id);
    const products = await tx.product.findMany({ where: { sku: { startsWith: SKU_PREFIX } }, select: { id: true, sku: true } });
    // Demo products referenced by non-demo sales cannot be removed (FK + history).
    const blocked = new Set(
      (await tx.saleItem.findMany({ where: { productId: { in: products.map((p) => p.id) }, saleId: { notIn: saleIds } }, select: { productId: true }, distinct: ['productId'] })).map((i) => i.productId),
    );
    const removable = products.filter((p) => !blocked.has(p.id)).map((p) => p.id);

    const counts = {
      sales: saleIds.length,
      saleItems: await tx.saleItem.count({ where: { saleId: { in: saleIds } } }),
      payments: await tx.payment.count({ where: { saleId: { in: saleIds } } }),
      auditLogs: await tx.auditLog.count({ where: { entityType: 'Sale', entityId: { in: saleIds } } }),
      saleMovements: await tx.inventoryMovement.count({ where: { referenceType: 'sale', referenceId: { in: saleIds } } }),
      productMovements: 0,
      products: removable.length,
    };
    // (referenceType can be NULL for receipts, so avoid NOT(...) which would drop NULL rows.)
    counts.productMovements =
      (await tx.inventoryMovement.count({ where: { productId: { in: removable } } })) -
      (await tx.inventoryMovement.count({ where: { productId: { in: removable }, referenceType: 'sale', referenceId: { in: saleIds } } }));

    if (!dryRun) {
      await tx.auditLog.deleteMany({ where: { entityType: 'Sale', entityId: { in: saleIds } } });
      await tx.inventoryMovement.deleteMany({ where: { referenceType: 'sale', referenceId: { in: saleIds } } });
      await tx.sale.deleteMany({ where: { id: { in: saleIds } } }); // items + payments cascade
      await tx.inventoryMovement.deleteMany({ where: { productId: { in: removable } } });
      await tx.product.deleteMany({ where: { id: { in: removable } } });
    }

    const emptyOf = async (model: 'category' | 'brand', names: string[]) => {
      const found: { id: string; name: string }[] = [];
      for (const name of names) {
        const row = await (tx[model] as typeof tx.category).findUnique({ where: { name }, include: { products: { select: { id: true } } } });
        if (!row) continue;
        const left = row.products.filter((p) => !removable.includes(p.id)).length;
        if (left === 0) found.push({ id: row.id, name });
      }
      return found;
    };
    const cats = await emptyOf('category', [CAT_BEV, CAT_SNK, CAT_HH]);
    const brands = await emptyOf('brand', [B1, B2]);
    const taxRow = await tx.taxCategory.findUnique({ where: { name: DEMO_TAX_NAME }, include: { products: { select: { id: true } } } });
    const taxGone = taxRow && taxRow.products.every((p) => removable.includes(p.id)) ? taxRow : null;
    const unitRow = await tx.unit.findUnique({ where: { name: DEMO_UNIT_NAME }, include: { products: { select: { id: true } } } });
    const unitGone = unitRow && unitRow.products.every((p) => removable.includes(p.id)) ? unitRow : null;

    if (!dryRun) {
      await tx.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } });
      await tx.brand.deleteMany({ where: { id: { in: brands.map((b) => b.id) } } });
      if (taxGone) await tx.taxCategory.delete({ where: { id: taxGone.id } });
      if (unitGone) await tx.unit.delete({ where: { id: unitGone.id } });
    }

    console.log(dryRun ? 'DRY RUN: would delete (nothing changed):' : 'Deleted:');
    console.log(`  sales ${counts.sales}, sale items ${counts.saleItems}, payments ${counts.payments}, audit rows ${counts.auditLogs}`);
    console.log(`  stock movements ${counts.saleMovements + counts.productMovements} (sale-linked ${counts.saleMovements}, opening/receipts ${counts.productMovements})`);
    console.log(`  products ${counts.products}, categories ${cats.length}, brands ${brands.length}, demo tax categories ${taxGone ? 1 : 0}, demo units ${unitGone ? 1 : 0}`);
    if (blocked.size) console.log(`  KEPT ${blocked.size} DEMO- product(s) referenced by non-demo sales.`);
  }, TX_OPTS);
}

async function main() {
  guardProduction();
  const args = process.argv.slice(2);
  if (args.includes('--clear')) await clear(args.includes('--dry-run'));
  else await seed();
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
