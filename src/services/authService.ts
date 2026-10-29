import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import type { AuthTokens } from '@hydrosure/shared';
import { prisma, type Tx } from '../db';
import { config } from '../config';
import { AppError, forbidden, unauthorized } from '../errors';
import { verifyGoogleIdToken } from './googleVerifier';
import { signAccessToken } from '../middleware/auth';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const newToken = () => crypto.randomBytes(48).toString('base64url');

// Used to equalise timing when the user does not exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12);

const ADMIN_ONLY = 'Google sign-in is only available for admin accounts';

type U = { id: string; email: string; name: string; role: 'admin' | 'manager' | 'cashier' };

async function issue(tx: Tx, user: U, familyId: string): Promise<AuthTokens> {
  const refreshToken = newToken();
  await tx.refreshToken.create({
    data: {
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    },
  });
  return {
    accessToken: signAccessToken(user),
    refreshToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
}

export async function login(email: string, password: string): Promise<AuthTokens> {
  const user = await prisma.user.findUnique({ where: { email } });
  // Google-only users (null passwordHash) are treated like a missing user.
  const hash = user?.passwordHash ?? null;
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  if (!user || !hash || !ok || !user.active) throw unauthorized('Invalid credentials');
  return prisma.$transaction((tx) => issue(tx, user, crypto.randomUUID()));
}

/**
 * Signs in with a Google ID token. Match order: googleSub, then verified email (linking the
 * account). Admin accounts only; unknown emails are never auto-created.
 */
export async function googleLogin(idToken: string): Promise<AuthTokens> {
  // Fail closed: google-auth-library skips the audience check when audience is undefined.
  if (!config.GOOGLE_CLIENT_ID || config.GOOGLE_CLIENT_ID.startsWith('your-client-id')) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Google sign-in is not configured');
  }
  let payload;
  try {
    payload = await verifyGoogleIdToken(idToken);
  } catch {
    throw unauthorized('Invalid Google token');
  }
  if (!payload?.sub || !payload.email) throw unauthorized('Invalid Google token');
  if (payload.email_verified !== true) throw forbidden('Google email is not verified');
  const sub = payload.sub;
  const email = payload.email.trim().toLowerCase();

  const resolve = async () => {
    const bySub = await prisma.user.findUnique({ where: { googleSub: sub } });
    if (bySub) return bySub;
    // Case-insensitive so legacy mixed-case rows still match.
    const byEmail = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (byEmail) {
      if (byEmail.googleSub && byEmail.googleSub !== sub) throw forbidden('Account is linked to a different Google account');
      // Check active/role before binding so an inactive or non-admin user never gets a sub.
      if (!byEmail.active) throw forbidden('Account is inactive');
      if (byEmail.role !== 'admin') throw forbidden(ADMIN_ONLY);
      return byEmail.googleSub ? byEmail : prisma.user.update({ where: { id: byEmail.id }, data: { googleSub: sub } });
    }
    throw forbidden(ADMIN_ONLY);
  };

  let user;
  try {
    user = await resolve();
  } catch (e) {
    // Lost a link race (unique violation): re-read and run the normal checks once more.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    user = await resolve();
  }
  if (!user.active) throw forbidden('Account is inactive');
  if (user.role !== 'admin') throw forbidden(ADMIN_ONLY);
  const u = user;
  return prisma.$transaction((tx) => issue(tx, u, crypto.randomUUID()));
}

/**
 * Rotates the refresh token. Presenting an already-rotated (revoked) token is
 * treated as theft: the entire token family is revoked.
 */
export async function refresh(token: string): Promise<AuthTokens> {
  const hash = sha256(token);
  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.refreshToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
    if (!row) return { error: 'Invalid refresh token' } as const;
    if (row.revokedAt) {
      await tx.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { error: 'Refresh token reuse detected' } as const;
    }
    if (row.expiresAt < new Date() || !row.user.active) return { error: 'Refresh token expired' } as const;

    // Atomic claim guards against two concurrent refreshes of the same token.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) return { error: 'Invalid refresh token' } as const;

    const tokens = await issue(tx, row.user, row.familyId);
    const next = await tx.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256(tokens.refreshToken) },
    });
    await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: next.id } });
    return { tokens } as const;
  });
  // Throw outside the transaction so the reuse-revocation above is committed.
  if ('error' in result) throw unauthorized(result.error);
  return result.tokens;
}

export async function logout(token: string): Promise<void> {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row) return;
  await prisma.refreshToken.updateMany({
    where: { familyId: row.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
