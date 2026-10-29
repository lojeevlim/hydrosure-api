import { Router } from 'express';
import type { ZodType } from 'zod';
import {
  brandInputSchema,
  categoryInputSchema,
  supplierInputSchema,
  taxCategoryInputSchema,
  tagInputSchema,
  unitInputSchema,
} from '@hydrosure/shared';
import { prisma } from '../db';
import { authenticate, requireManager } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function crud(model: 'category' | 'brand' | 'unit' | 'tag' | 'supplier' | 'taxCategory', schema: ZodType<any>) {
  // Prisma delegates share the same shape for the methods used here.
  const d = prisma[model] as unknown as {
    findMany(a: unknown): Promise<unknown[]>;
    findUniqueOrThrow(a: unknown): Promise<unknown>;
    create(a: unknown): Promise<unknown>;
    update(a: unknown): Promise<unknown>;
    delete(a: unknown): Promise<unknown>;
  };
  const r = Router();
  r.use(authenticate);
  r.get('/', async (_req, res) => res.json(await d.findMany({ orderBy: { name: 'asc' } })));
  r.get('/:id', async (req, res) => res.json(await d.findUniqueOrThrow({ where: { id: req.params.id } })));
  r.post('/', requireManager, async (req, res) => {
    res.status(201).json(await d.create({ data: schema.parse(req.body) }));
  });
  r.patch('/:id', requireManager, async (req, res) => {
    const data = (schema as unknown as { partial(): ZodType }).partial().parse(req.body);
    res.json(await d.update({ where: { id: req.params.id }, data }));
  });
  r.delete('/:id', requireManager, async (req, res) => {
    await d.delete({ where: { id: req.params.id } }); // FK violation -> 409 via error handler
    res.status(204).end();
  });
  return r;
}

export const categoriesRouter = crud('category', categoryInputSchema);
export const brandsRouter = crud('brand', brandInputSchema);
export const unitsRouter = crud('unit', unitInputSchema);
export const tagsRouter = crud('tag', tagInputSchema);
export const suppliersRouter = crud('supplier', supplierInputSchema);
export const taxCategoriesRouter = crud('taxCategory', taxCategoryInputSchema);
