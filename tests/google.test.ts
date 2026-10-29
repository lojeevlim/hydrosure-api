import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/db';
import { config } from '../src/config';
import { app, createUser, resetDb, PASSWORD } from './helpers';

vi.mock('../src/services/googleVerifier', () => ({ verifyGoogleIdToken: vi.fn() }));
import { verifyGoogleIdToken } from '../src/services/googleVerifier';

const verify = vi.mocked(verifyGoogleIdToken);
const google = (idToken = 'tok') => request(app).post('/api/auth/google').send({ idToken });
const asGoogle = (p: { sub?: string; email: string; email_verified?: boolean; name?: string }) =>
  verify.mockResolvedValue({ sub: 'sub-1', email_verified: true, ...p } as never);

beforeEach(async () => {
  await resetDb();
  verify.mockReset();
});

describe('google login', () => {
  it('links an existing admin by email, then signs in by googleSub', async () => {
    const user = await createUser('admin');
    asGoogle({ email: 'Admin@test.local' });
    const first = await google();
    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({ id: user.id, role: 'admin' });
    expect(first.body.accessToken).toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).googleSub).toBe('sub-1');

    // Email on the Google account changed: the stable sub still matches.
    asGoogle({ email: 'renamed@test.local' });
    const second = await google();
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(user.id);
  });

  it.each(['cashier', 'manager'] as const)('rejects a %s account and does not link googleSub', async (role) => {
    await createUser(role);
    asGoogle({ email: `${role}@test.local` });
    const res = await google();
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/admin accounts/);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: `${role}@test.local` } })).googleSub).toBeNull();
  });

  it('rejects an email already linked to a different Google account', async () => {
    await createUser('admin');
    await prisma.user.update({ where: { email: 'admin@test.local' }, data: { googleSub: 'other' } });
    asGoogle({ email: 'admin@test.local' });
    expect((await google()).status).toBe(403);
  });

  it('rejects an unknown email and never creates a user', async () => {
    asGoogle({ sub: 'sub-x', email: 'stranger@test.local' });
    expect((await google()).status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects an unverified Google email', async () => {
    await createUser('admin');
    asGoogle({ email: 'admin@test.local', email_verified: false });
    expect((await google()).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } })).googleSub).toBeNull();
  });

  it('rejects inactive users', async () => {
    await createUser('admin');
    await prisma.user.update({ where: { email: 'admin@test.local' }, data: { active: false } });
    asGoogle({ email: 'admin@test.local' });
    expect((await google()).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } })).googleSub).toBeNull();
  });

  it('returns 503 and never verifies when GOOGLE_CLIENT_ID is unset or a placeholder', async () => {
    const original = config.GOOGLE_CLIENT_ID;
    try {
      for (const v of [undefined, 'your-client-id.apps.googleusercontent.com']) {
        config.GOOGLE_CLIENT_ID = v;
        asGoogle({ email: 'admin@test.local' });
        expect((await google()).status).toBe(503);
      }
      expect(verify).not.toHaveBeenCalled();
    } finally {
      config.GOOGLE_CLIENT_ID = original;
    }
  });

  it('keeps password login working after linking Google', async () => {
    await createUser('admin');
    asGoogle({ email: 'admin@test.local' });
    expect((await google()).status).toBe(200);
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('returns 401 when the token payload lacks sub or email', async () => {
    await createUser('admin');
    verify.mockResolvedValue({ email: 'admin@test.local', email_verified: true } as never);
    expect((await google()).status).toBe(401);
    verify.mockResolvedValue({ sub: 'sub-1', email_verified: true } as never);
    expect((await google()).status).toBe(401);
  });

  it('returns 403 when email_verified is missing', async () => {
    await createUser('admin');
    verify.mockResolvedValue({ sub: 'sub-1', email: 'admin@test.local' } as never);
    expect((await google()).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } })).googleSub).toBeNull();
  });

  it('returns 401 for an invalid token for an invalid token', async () => {
    verify.mockRejectedValue(new Error('bad token'));
    expect((await google()).status).toBe(401);
  });

  it('does not let a Google-only user password-login', async () => {
    await prisma.user.create({ data: { email: 'new@test.local', name: 'New', role: 'admin' } });
    asGoogle({ sub: 'sub-new', email: 'new@test.local' });
    expect((await google()).status).toBe(200);
    for (const password of [PASSWORD, 'dummy-password']) {
      const res = await request(app).post('/api/auth/login').send({ email: 'new@test.local', password });
      expect(res.status).toBe(401);
    }
  });
});
