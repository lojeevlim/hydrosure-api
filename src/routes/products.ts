import { Router } from 'express';
import {
  productCreateSchema,
  productListQuerySchema,
  productUpdateSchema,
  type Paginated,
} from '@hydrosure/shared';
import { prisma, Prisma } from '../db';
import { actor, authenticate, requireManager } from '../middleware/auth';
import { applyMovement } from '../services/inventoryService';
import { AppError, notFound } from '../errors';

export const productsRouter = Router();
productsRouter.use(authenticate);

const include = {
  category: true,
  brand: true,
  unit: true,
  supplier: true,
  taxCategory: true,
  tags: true,
} satisfies Prisma.ProductInclude;

/** Cashiers must not see purchase cost or wholesale pricing. */
function redact<T extends { cost?: unknown; wholesalePrice?: unknown }>(role: string, p: T): T {
  if (role !== 'cashier') return p;
  const { cost: _c, wholesalePrice: _w, ...rest } = p;
  return rest as T;
}

productsRouter.get('/', async (req, res) => {
  const q = productListQuerySchema.parse(req.query);
  const and: Prisma.ProductWhereInput[] = [{ archivedAt: q.archived ? { not: null } : null }];
  if (q.search) {
    and.push({
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { sku: { contains: q.search, mode: 'insensitive' } },
        { barcode: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  if (q.barcode) and.push({ barcode: q.barcode });
  if (q.categoryId) and.push({ categoryId: q.categoryId });
  if (q.brandId) and.push({ brandId: q.brandId });
  if (q.supplierId) and.push({ supplierId: q.supplierId });
  if (q.tagId) and.push({ tags: { some: { id: q.tagId } } });
  if (q.stock === 'out') and.push({ stockQty: { lte: 0 } });
  const where: Prisma.ProductWhereInput = { AND: and };

  if (q.stock === 'low') {
    // stockQty <= reorderLevel compares two columns; resolve ids via raw SQL.
    const ids = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Product" WHERE "stockQty" <= "reorderLevel" AND "archivedAt" IS NULL`;
    and.push({ id: { in: ids.map((i) => i.id) } });
  }
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include,
      orderBy: { [q.sortBy]: q.sortDir },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  const role = actor(req).role;
  const body: Paginated<(typeof items)[number]> = {
    items: items.map((p) => redact(role, p)),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.ceil(total / q.pageSize),
  };
  res.json(body);
});

productsRouter.get('/:id', async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id }, include });
  if (!p) throw notFound('Product not found');
  res.json(redact(actor(req).role, p));
});

/** Date-only strings (validated by zod) -> Date for Prisma @db.Date columns. */
const withDate = <T extends { expirationDate?: string | null }>(d: T) => {
  const { expirationDate, ...rest } = d;
  return expirationDate === undefined
    ? rest
    : { ...rest, expirationDate: expirationDate === null ? null : new Date(`${expirationDate}T00:00:00Z`) };
};

productsRouter.post('/', requireManager, async (req, res) => {
  const { tagIds, openingQty, ...data } = productCreateSchema.parse(req.body);
  const user = actor(req);
  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: { ...withDate(data), tags: { connect: tagIds.map((id) => ({ id })) } },
    });
    if (openingQty > 0) {
      await applyMovement(tx, {
        productId: created.id,
        type: 'opening_balance',
        qtyChange: openingQty,
        referenceType: 'product',
        referenceId: created.id,
        userId: user.id,
      });
    }
    return tx.product.findUniqueOrThrow({ where: { id: created.id }, include });
  });
  res.status(201).json(product);
});

productsRouter.patch('/:id', requireManager, async (req, res) => {
  const { tagIds, ...data } = productUpdateSchema.parse(req.body);
  if (data.maxStock !== undefined || data.reorderLevel !== undefined) {
    // The schema can only compare fields present in the body; check against stored values too.
    const cur = await prisma.product.findUnique({ where: { id: String(req.params.id) }, select: { maxStock: true, reorderLevel: true } });
    if (!cur) throw notFound('Product not found');
    const max = data.maxStock !== undefined ? data.maxStock : cur.maxStock;
    const reorder = data.reorderLevel ?? cur.reorderLevel;
    if (max != null && max < reorder) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
        { path: 'maxStock', message: 'Max stock must be at least the reorder level' },
      ]);
    }
  }
  const product = await prisma.product.update({
    where: { id: String(req.params.id) },
    data: { ...withDate(data), ...(tagIds ? { tags: { set: tagIds.map((id) => ({ id })) } } : {}) },
    include,
  });
  res.json(product);
});

productsRouter.post('/:id/archive', requireManager, async (req, res) => {
  res.json(await prisma.product.update({ where: { id: String(req.params.id) }, data: { archivedAt: new Date() }, include }));
});
productsRouter.post('/:id/unarchive', requireManager, async (req, res) => {
  res.json(await prisma.product.update({ where: { id: String(req.params.id) }, data: { archivedAt: null }, include }));
});
// Soft delete: products referenced by sales/movements must never be hard-deleted.
productsRouter.delete('/:id', requireManager, async (req, res) => {
  await prisma.product.update({ where: { id: String(req.params.id) }, data: { archivedAt: new Date() } });
  res.status(204).end();
});
