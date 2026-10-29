import { Router } from 'express';
import { heldCartInputSchema } from '@hydrosure/shared';
import { prisma } from '../db';
import { actor, authenticate } from '../middleware/auth';
import { notFound } from '../errors';

export const heldCartsRouter = Router();
heldCartsRouter.use(authenticate);

// Held carts are private to the cashier who parked them (managers+ may see all).
const scope = (req: Parameters<typeof actor>[0]) =>
  actor(req).role === 'cashier' ? { userId: actor(req).id } : {};

heldCartsRouter.post('/', async (req, res) => {
  const b = heldCartInputSchema.parse(req.body);
  const cart = await prisma.heldCart.create({
    data: {
      userId: actor(req).id,
      label: b.label ?? null,
      customerId: b.customerId ?? null,
      items: b.items as unknown as object,
    },
  });
  res.status(201).json(cart);
});

heldCartsRouter.get('/', async (req, res) => {
  res.json(await prisma.heldCart.findMany({ where: scope(req), orderBy: { createdAt: 'desc' } }));
});

/** Resume = return the cart contents and remove the hold, atomically. */
heldCartsRouter.post('/:id/resume', async (req, res) => {
  const cart = await prisma.$transaction(async (tx) => {
    const c = await tx.heldCart.findFirst({ where: { id: req.params.id, ...scope(req) } });
    if (!c) throw notFound('Held cart not found');
    const del = await tx.heldCart.deleteMany({ where: { id: c.id } });
    if (del.count === 0) throw notFound('Held cart not found'); // resumed concurrently
    return c;
  });
  res.json(cart);
});

heldCartsRouter.delete('/:id', async (req, res) => {
  const r = await prisma.heldCart.deleteMany({ where: { id: req.params.id, ...scope(req) } });
  if (r.count === 0) throw notFound('Held cart not found');
  res.status(204).end();
});
