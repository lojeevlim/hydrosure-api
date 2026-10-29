import type { MovementType } from '@prisma/client';
import type { Tx } from '../db';
import { badRequest, conflict, notFound } from '../errors';

/** Product.stockQty is a 32-bit Postgres integer. */
const MAX_STOCK = 2_147_483_647;

export interface ApplyMovementInput {
  productId: string;
  type: MovementType;
  /** Signed quantity delta. */
  qtyChange: number;
  referenceType?: string | null;
  referenceId?: string | null;
  reason?: string | null;
  userId?: string | null;
  /** Default false: stock may never go below zero. */
  allowNegative?: boolean;
}

/**
 * The ONLY place product stock changes. Must be called inside a Prisma
 * transaction: locks the product row, records before/after quantities and
 * writes the movement atomically with the stock update.
 */
export async function applyMovement(tx: Tx, input: ApplyMovementInput) {
  const rows = await tx.$queryRaw<{ stockQty: number }[]>`
    SELECT "stockQty" FROM "Product" WHERE id = ${input.productId} FOR UPDATE`;
  if (rows.length === 0) throw notFound('Product not found');

  const qtyBefore = rows[0]!.stockQty;
  const qtyAfter = qtyBefore + input.qtyChange;
  if (qtyAfter > MAX_STOCK) {
    throw badRequest('Resulting stock quantity is too large', { productId: input.productId, max: MAX_STOCK });
  }
  if (qtyAfter < 0 && !input.allowNegative) {
    throw conflict('Insufficient stock', {
      productId: input.productId,
      available: qtyBefore,
      requested: -input.qtyChange,
    });
  }

  await tx.product.update({ where: { id: input.productId }, data: { stockQty: qtyAfter } });
  return tx.inventoryMovement.create({
    data: {
      productId: input.productId,
      type: input.type,
      qtyChange: input.qtyChange,
      qtyBefore,
      qtyAfter,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      reason: input.reason ?? null,
      userId: input.userId ?? null,
    },
  });
}
