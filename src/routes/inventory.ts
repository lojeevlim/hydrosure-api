import { Router } from 'express';
import {
  adjustmentInputSchema,
  movementListQuerySchema,
  openingBalanceInputSchema,
  receiptInputSchema,
  stockListQuerySchema,
  writeOffInputSchema,
} from '@hydrosure/shared';
import { prisma, Prisma } from '../db';
import { actor, authenticate, requireManager } from '../middleware/auth';
import { applyMovement } from '../services/inventoryService';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

inventoryRouter.get('/movements', requireManager, async (req, res) => {
  const q = movementListQuerySchema.parse(req.query);
  const where: Prisma.InventoryMovementWhereInput = {
    ...(q.productId ? { productId: q.productId } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            // A date-only "to" includes that whole UTC day.
            ...(q.to
              ? DATE_ONLY.test(q.to)
                ? { lt: new Date(new Date(q.to).getTime() + 86_400_000) }
                : { lte: new Date(q.to) }
              : {}),
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.inventoryMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        product: { select: { id: true, sku: true, name: true } },
        user: { select: { id: true, name: true } },
      },
    }),
    prisma.inventoryMovement.count({ where }),
  ]);
  res.json({ items, page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) });
});

/** Low-stock (stockQty <= reorderLevel) or out-of-stock (<= 0) products. */
inventoryRouter.get('/stock', requireManager, async (req, res) => {
  const q = stockListQuerySchema.parse(req.query);
  const cond =
    q.status === 'out'
      ? Prisma.sql`"stockQty" <= 0`
      : Prisma.sql`"stockQty" <= "reorderLevel"`;
  const offset = (q.page - 1) * q.pageSize;
  const items = await prisma.$queryRaw`
    SELECT id, sku, name, cost, "stockQty", "reorderLevel", "maxStock" FROM "Product"
    WHERE "archivedAt" IS NULL AND ${cond}
    ORDER BY "stockQty" ASC, name ASC LIMIT ${q.pageSize} OFFSET ${offset}`;
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "Product" WHERE "archivedAt" IS NULL AND ${cond}`;
  const total = Number(count);
  res.json({ items, page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) });
});

inventoryRouter.post('/receipts', requireManager, async (req, res) => {
  const b = receiptInputSchema.parse(req.body);
  const user = actor(req);
  const movement = await prisma.$transaction(async (tx) => {
    const m = await applyMovement(tx, {
      productId: b.productId,
      type: 'receipt',
      qtyChange: b.qty,
      referenceType: b.supplierId ? 'supplier' : null,
      referenceId: b.supplierId ?? null,
      reason: b.reason,
      userId: user.id,
    });
    if (b.unitCost !== undefined) {
      await tx.product.update({ where: { id: b.productId }, data: { cost: b.unitCost } });
    }
    return m;
  });
  res.status(201).json(movement);
});

inventoryRouter.post('/opening-balance', requireManager, async (req, res) => {
  const b = openingBalanceInputSchema.parse(req.body);
  const m = await prisma.$transaction((tx) =>
    applyMovement(tx, {
      productId: b.productId,
      type: 'opening_balance',
      qtyChange: b.qty,
      reason: b.reason,
      userId: actor(req).id,
    }),
  );
  res.status(201).json(m);
});

inventoryRouter.post('/adjustments', requireManager, async (req, res) => {
  const b = adjustmentInputSchema.parse(req.body);
  const m = await prisma.$transaction((tx) =>
    applyMovement(tx, {
      productId: b.productId,
      type: 'adjustment',
      qtyChange: b.qtyChange,
      reason: b.reason,
      userId: actor(req).id,
    }),
  );
  res.status(201).json(m);
});

inventoryRouter.post('/write-offs', requireManager, async (req, res) => {
  const b = writeOffInputSchema.parse(req.body);
  const m = await prisma.$transaction((tx) =>
    applyMovement(tx, {
      productId: b.productId,
      type: b.type,
      qtyChange: -b.qty,
      reason: b.reason,
      userId: actor(req).id,
    }),
  );
  res.status(201).json(m);
});
