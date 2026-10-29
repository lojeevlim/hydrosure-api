import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { googleLoginSchema, loginSchema, refreshSchema } from '@hydrosure/shared';
import { config } from '../config';
import * as authService from '../services/authService';
import { authenticate, actor } from '../middleware/auth';
import { prisma } from '../db';
import { unauthorized } from '../errors';

export const authRouter = Router();

const limited = { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } };

// Login: keyed by IP + email so one attacker cannot lock out everyone behind a shared IP,
// and only failed attempts count.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    return `${ipKeyGenerator(req.ip ?? '')}|${email}`;
  },
  message: limited,
});

// Google sign-in: only failed attempts count, keyed by IP (the token itself is not a stable key).
const googleLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
  message: limited,
});

// Refresh is called automatically by clients, so it gets a higher, separate budget.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.AUTH_RATE_LIMIT_MAX * 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limited,
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  res.json(await authService.login(email, password));
});

authRouter.post('/google', googleLimiter, async (req, res) => {
  const { idToken } = googleLoginSchema.parse(req.body);
  res.json(await authService.googleLogin(idToken));
});

authRouter.post('/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  res.json(await authService.refresh(refreshToken));
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  await authService.logout(refreshToken);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: actor(req).id },
    select: { id: true, email: true, name: true, role: true, active: true },
  });
  if (!user || !user.active) throw unauthorized();
  res.json(user);
});
