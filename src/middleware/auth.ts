import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@hydrosure/shared';
import { config } from '../config';
import { prisma } from '../db';
import { forbidden, unauthorized } from '../errors';

export interface AuthContext {
  id: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function signAccessToken(user: { id: string; role: Role }): string {
  return jwt.sign({ role: user.role }, config.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: config.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

// Short-lived cache so a deactivation/demotion takes effect within seconds
// without a DB read on every request. Disabled (TTL 0) under test.
const USER_CACHE_TTL_MS = config.NODE_ENV === 'test' ? 0 : 15_000;
const userCache = new Map<string, { active: boolean; role: Role; expires: number }>();

/** Drop cached user state (call after deactivating a user or changing a role). */
export function invalidateUserCache(id?: string) {
  if (id) userCache.delete(id);
  else userCache.clear();
}

async function loadUser(id: string) {
  const hit = userCache.get(id);
  if (hit && hit.expires > Date.now()) return hit;
  const u = await prisma.user.findUnique({ where: { id }, select: { active: true, role: true } });
  if (!u) {
    userCache.delete(id);
    return null;
  }
  const entry = { active: u.active, role: u.role as Role, expires: Date.now() + USER_CACHE_TTL_MS };
  if (USER_CACHE_TTL_MS > 0) userCache.set(id, entry);
  return entry;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  let sub: string;
  try {
    const payload = jwt.verify(header.slice(7), config.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (!payload.sub || !payload.role) throw new Error('bad payload');
    sub = payload.sub;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  // The DB, not the token, is the source of truth for status and role.
  const user = await loadUser(sub);
  if (!user || !user.active) throw unauthorized('Invalid or expired token');
  req.auth = { id: sub, role: user.role };
  next();
}

const rank: Record<Role, number> = { cashier: 1, manager: 2, admin: 3 };

/** Allows the given minimum role or higher (admin > manager > cashier). */
export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    if (rank[req.auth.role] < rank[min]) throw forbidden('Insufficient role');
    next();
  };
}

export const requireManager = requireRole('manager');
export const requireAdmin = requireRole('admin');

export function actor(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
