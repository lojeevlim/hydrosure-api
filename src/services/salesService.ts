import crypto from 'node:crypto';
import type { CheckoutInput, CartItemInput, DiscountInput } from '@hydrosure/shared';
import { prisma, Prisma, type Tx } from '../db';
import { AppError, badRequest, conflict, notFound } from '../errors';
import { applyMovement } from './inventoryService';
import { getProvider } from '../payments/provider';

const cents = (d: Prisma.Decimal | number) => Math.round(Number(d) * 100);
const money = (c: number) => new Prisma.Decimal(c).div(100);

export const saleInclude = {
  items: true,
  payments: true,
  customer: true,
  cashier: { select: { id: true, name: true, email: true } },
  voidedBy: { select: { id: true, name: true } },
} satisfies Prisma.SaleInclude;

function discountCents(gross: number, d?: DiscountInput): number {
  if (!d) return 0;
  const amt = d.type === 'percent' ? Math.round((gross * d.value) / 100) : Math.round(d.value * 100);
  if (amt > gross) throw badRequest('Discount exceeds line amount');
  return amt;
}

/** Merge duplicate product lines so each product is locked/validated once. */
function mergeLines(items: CartItemInput[]): CartItemInput[] {
  const map = new Map<string, CartItemInput>();
  for (const it of items) {
    const prev = map.get(it.productId);
    if (!prev) map.set(it.productId, { ...it });
    else {
      if (JSON.stringify(prev.discount) !== JSON.stringify(it.discount))
        throw badRequest('Duplicate product lines must carry identical discounts');
      prev.qty += it.qty;
    }
  }
  return [...map.values()];
}

/** Stable hash of everything that determines the outcome of a checkout request. */
export function checkoutFingerprint(input: CheckoutInput): string {
  const items = [...input.items]
    .map((i) => ({
      productId: i.productId,
      qty: i.qty,
      discount: i.discount ? { type: i.discount.type, value: i.discount.value } : null,
    }))
    .sort((a, b) =>
      a.productId === b.productId
        ? JSON.stringify(a).localeCompare(JSON.stringify(b))
        : a.productId.localeCompare(b.productId),
    );
  const canonical = JSON.stringify({
    items,
    customerId: input.customerId ?? null,
    payment: {
      method: input.payment.method,
      amount: input.payment.amount,
      externalRef: input.payment.externalRef ?? null,
    },
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Keys are unique per cashier (DB constraint), so another user's key can never
 * be observed. A same-cashier hit must carry the same payload to be replayed.
 */
async function replayExisting(cashierId: string, key: string, fingerprint: string) {
  const existing = await prisma.sale.findUnique({
    where: { cashierId_idempotencyKey: { cashierId, idempotencyKey: key } },
    include: saleInclude,
  });
  if (!existing) return null;
  if (existing.idempotencyFingerprint && existing.idempotencyFingerprint !== fingerprint) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different request');
  }
  return { sale: existing, replay: true };
}

export async function checkout(input: CheckoutInput, cashierId: string) {
  const fingerprint = checkoutFingerprint(input);
  const prior = await replayExisting(cashierId, input.idempotencyKey, fingerprint);
  if (prior) return prior;

  try {
    const sale = await prisma.$transaction(async (tx) => {
      const lines = mergeLines(input.items).sort((a, b) => a.productId.localeCompare(b.productId));
      const products = await tx.product.findMany({
        where: { id: { in: lines.map((l) => l.productId) } },
        include: { taxCategory: true },
      });
      const byId = new Map(products.map((p) => [p.id, p]));

      let subtotal = 0;
      let discountTotal = 0;
      let taxTotal = 0;
      const itemRows = lines.map((l) => {
        const p = byId.get(l.productId);
        if (!p) throw notFound(`Product ${l.productId} not found`);
        if (p.archivedAt) throw conflict(`Product ${p.sku} is archived`);
        const gross = cents(p.price) * l.qty;
        const disc = discountCents(gross, l.discount);
        const net = gross - disc;
        const rate = p.taxCategory ? Number(p.taxCategory.rate) : 0;
        const tax = Math.round((net * rate) / 100);
        subtotal += gross;
        discountTotal += disc;
        taxTotal += tax;
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          qty: l.qty,
          unitPrice: p.price,
          unitCost: p.cost,
          taxRate: new Prisma.Decimal(rate),
          discountAmount: money(disc),
          lineSubtotal: money(net),
          taxAmount: money(tax),
          lineTotal: money(net + tax),
        };
      });
      const total = subtotal - discountTotal + taxTotal;

      if (input.customerId) {
        const c = await tx.customer.findUnique({ where: { id: input.customerId } });
        if (!c) throw notFound('Customer not found');
      }

      const pay = getProvider(input.payment.method).charge({
        amountDue: total,
        amount: cents(input.payment.amount),
        externalRef: input.payment.externalRef,
      });

      const created = await tx.sale.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
          customerId: input.customerId ?? null,
          cashierId,
          subtotal: money(subtotal),
          discountTotal: money(discountTotal),
          taxTotal: money(taxTotal),
          total: money(total),
          items: { create: itemRows },
          payments: {
            create: {
              method: pay.method,
              status: pay.status,
              verified: pay.verified,
              amount: money(pay.amountApplied),
              tendered: money(pay.tendered),
              changeGiven: money(pay.change),
              externalRef: pay.externalRef,
            },
          },
        },
      });

      // Stock is deducted last; any insufficiency rolls back the whole sale.
      for (const l of lines) {
        await applyMovement(tx, {
          productId: l.productId,
          type: 'sale',
          qtyChange: -l.qty,
          referenceType: 'sale',
          referenceId: created.id,
          userId: cashierId,
        });
      }
      return tx.sale.findUniqueOrThrow({ where: { id: created.id }, include: saleInclude });
    });
    return { sale, replay: false };
  } catch (e) {
    // Concurrent request with the same key won the race: return its sale.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await replayExisting(cashierId, input.idempotencyKey, fingerprint);
      if (again) return again;
    }
    throw e;
  }
}

export async function voidSale(id: string, reason: string, userId: string) {
  return prisma.$transaction(async (tx: Tx) => {
    // Atomic claim: only one concurrent void can flip completed -> voided.
    const claimed = await tx.sale.updateMany({
      where: { id, status: 'completed' },
      data: { status: 'voided', voidedAt: new Date(), voidedById: userId, voidReason: reason },
    });
    if (claimed.count === 0) {
      const s = await tx.sale.findUnique({ where: { id }, select: { id: true } });
      if (!s) throw notFound('Sale not found');
      throw conflict('Sale is already voided');
    }
    const items = await tx.saleItem.findMany({ where: { saleId: id } });
    for (const it of items.sort((a, b) => a.productId.localeCompare(b.productId))) {
      await applyMovement(tx, {
        productId: it.productId,
        type: 'void_return',
        qtyChange: it.qty,
        referenceType: 'sale',
        referenceId: id,
        reason,
        userId,
      });
    }
    await tx.payment.updateMany({ where: { saleId: id }, data: { status: 'voided' } });
    await tx.auditLog.create({
      data: {
        userId,
        action: 'sale.void',
        entityType: 'Sale',
        entityId: id,
        metadata: { reason, itemCount: items.length },
      },
    });
    return tx.sale.findUniqueOrThrow({ where: { id }, include: saleInclude });
  });
}
