import { Router } from 'express';
import { checkoutSchema, saleListQuerySchema, voidSaleSchema } from '@hydrosure/shared';
import { prisma, Prisma } from '../db';
import { actor, authenticate, requireManager } from '../middleware/auth';
import { checkout, saleInclude, voidSale } from '../services/salesService';
import { notFound } from '../errors';
import { config } from '../config';

export const salesRouter = Router();
salesRouter.use(authenticate);

/** Cashiers must not see purchase cost (SaleItem.unitCost). */
function redactSale<T extends { items?: Array<{ unitCost?: unknown }> }>(role: string, sale: T): T {
  if (role !== 'cashier' || !sale.items) return sale;
  return { ...sale, items: sale.items.map(({ unitCost: _c, ...rest }) => rest) } as T;
}

const receiptNo = (n: number) => `R-${String(n).padStart(6, '0')}`;

salesRouter.post('/', async (req, res) => {
  const input = checkoutSchema.parse({
    ...req.body,
    idempotencyKey: req.body?.idempotencyKey ?? req.header('Idempotency-Key'),
  });
  const { sale, replay } = await checkout(input, actor(req).id);
  res.status(replay ? 200 : 201).json({ ...redactSale(actor(req).role, sale), receiptNo: receiptNo(sale.number), idempotentReplay: replay });
});

salesRouter.get('/', async (req, res) => {
  const q = saleListQuerySchema.parse(req.query);
  const where: Prisma.SaleWhereInput = {
    // Cashiers only see their own sales; managers+ see all.
    ...(actor(req).role === 'cashier' ? { cashierId: actor(req).id } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { payments: true, cashier: { select: { id: true, name: true } } },
    }),
    prisma.sale.count({ where }),
  ]);
  res.json({
    items: rows.map((s) => ({ ...s, receiptNo: receiptNo(s.number) })),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.ceil(total / q.pageSize),
  });
});

async function loadSale(id: string, req: Parameters<typeof actor>[0]) {
  const sale = await prisma.sale.findUnique({ where: { id }, include: saleInclude });
  // Treat other cashiers' sales as not found.
  if (!sale || (actor(req).role === 'cashier' && sale.cashierId !== actor(req).id)) {
    throw notFound('Sale not found');
  }
  return sale;
}

salesRouter.get('/:id', async (req, res) => {
  const sale = await loadSale(req.params.id, req);
  res.json({ ...redactSale(actor(req).role, sale), receiptNo: receiptNo(sale.number) });
});

salesRouter.get('/:id/receipt', async (req, res) => {
  const sale = await loadSale(req.params.id, req);
  res.json({
    store: { name: config.STORE_NAME, currency: config.CURRENCY_SYMBOL },
    receiptNo: receiptNo(sale.number),
    ...redactSale(actor(req).role, sale),
  });
});

salesRouter.post('/:id/void', requireManager, async (req, res) => {
  const { reason } = voidSaleSchema.parse(req.body);
  const sale = await voidSale(String(req.params.id), reason, actor(req).id);
  res.json({ ...sale, receiptNo: receiptNo(sale.number) });
});
