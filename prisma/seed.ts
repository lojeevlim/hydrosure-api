import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { strongPasswordSchema } from '../src/shared/auth';

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('Set SEED_ADMIN_PASSWORD in the environment before seeding.');
  }
  const strength = strongPasswordSchema.safeParse(password);
  if (!strength.success) {
    throw new Error(
      `SEED_ADMIN_PASSWORD is too weak: ${strength.error.issues.map((i) => i.message).join('; ')}.`,
    );
  }
  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Administrator', role: 'admin', passwordHash: await bcrypt.hash(password, 12) },
  });

  const unit = await prisma.unit.upsert({ where: { name: 'Piece' }, update: {}, create: { name: 'Piece', abbreviation: 'pc' } });
  const tax = await prisma.taxCategory.upsert({ where: { name: 'VAT 12%' }, update: {}, create: { name: 'VAT 12%', rate: 12 } });
  const zeroTax = await prisma.taxCategory.upsert({ where: { name: 'Zero rated' }, update: {}, create: { name: 'Zero rated', rate: 0 } });
  const beverages = await prisma.category.upsert({ where: { name: 'Beverages' }, update: {}, create: { name: 'Beverages' } });
  const snacks = await prisma.category.upsert({ where: { name: 'Snacks' }, update: {}, create: { name: 'Snacks' } });
  const brand = await prisma.brand.upsert({ where: { name: 'House Brand' }, update: {}, create: { name: 'House Brand' } });
  const supplier = await prisma.supplier.upsert({ where: { name: 'Sample Supplier Co.' }, update: {}, create: { name: 'Sample Supplier Co.' } });
  await prisma.customer.upsert({ where: { id: 'walk-in' }, update: {}, create: { id: 'walk-in', name: 'Walk-in Customer' } });

  const products = [
    { sku: 'BEV-001', barcode: '4800000000011', name: 'Bottled Water 500ml', categoryId: beverages.id, cost: 8, price: 15, tax: zeroTax.id, qty: 100 },
    { sku: 'BEV-002', barcode: '4800000000028', name: 'Iced Tea 350ml', categoryId: beverages.id, cost: 14, price: 25, tax: tax.id, qty: 60 },
    { sku: 'SNK-001', barcode: '4800000000035', name: 'Potato Chips 60g', categoryId: snacks.id, cost: 18, price: 32, tax: tax.id, qty: 40 },
    { sku: 'SNK-002', barcode: '4800000000042', name: 'Chocolate Bar 40g', categoryId: snacks.id, cost: 12, price: 22, tax: tax.id, qty: 5 },
  ];
  for (const p of products) {
    const exists = await prisma.product.findUnique({ where: { sku: p.sku } });
    if (exists) continue;
    await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          sku: p.sku, barcode: p.barcode, name: p.name, categoryId: p.categoryId, brandId: brand.id,
          unitId: unit.id, supplierId: supplier.id, taxCategoryId: p.tax, cost: p.cost, price: p.price,
          reorderLevel: 10, stockQty: p.qty,
        },
      });
      // Seed-only: write the opening movement directly so history matches stock.
      await tx.inventoryMovement.create({
        data: { productId: created.id, type: 'opening_balance', qtyChange: p.qty, qtyBefore: 0, qtyAfter: p.qty, reason: 'Seed data', userId: admin.id },
      });
    });
  }
  console.log(`Seeded admin ${email} and sample catalog.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
