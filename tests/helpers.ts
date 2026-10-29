import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';

export const app = createApp();
export const PASSWORD = 'Passw0rd!test';

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AuditLog","HeldCart","Payment","SaleItem","Sale","InventoryMovement","ProductVariant","_ProductToTag","Product","Customer","TaxCategory","Supplier","Tag","Unit","Brand","Category","RefreshToken","User" RESTART IDENTITY CASCADE`,
  );
}

export async function createUser(role: 'admin' | 'manager' | 'cashier') {
  const hash = await bcrypt.hash(PASSWORD, 4);
  return prisma.user.create({
    data: { email: `${role}@test.local`, name: role, role, passwordHash: hash },
  });
}

export async function loginAs(role: 'admin' | 'manager' | 'cashier') {
  const res = await request(app).post('/api/auth/login').send({ email: `${role}@test.local`, password: PASSWORD });
  return res.body as { accessToken: string; refreshToken: string };
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
