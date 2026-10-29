import { z } from 'zod';
import { roleSchema } from './common';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(200),
});
// Applied wherever a password is CREATED or CHANGED. Never use for login (existing accounts must still sign in).
export const strongPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a digit')
  .regex(/[^A-Za-z0-9]/, 'Password must contain a symbol')
  .refine((v) => !/password/i.test(v), 'Password must not contain the word "password"');

export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20) });
export type RefreshInput = z.infer<typeof refreshSchema>;

export const googleLoginSchema = z.object({ idToken: z.string().min(1) });
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
});
export type AuthUser = z.infer<typeof authUserSchema>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}
