import { describe, expect, it } from 'vitest';
import { strongPasswordSchema } from '../src/shared/auth';

describe('strongPasswordSchema', () => {
  const ok = (v: string) => strongPasswordSchema.safeParse(v).success;

  it('accepts a strong password', () => {
    expect(ok('Tr0ub4dor&Horse!')).toBe(true);
  });

  it('rejects weak passwords', () => {
    expect(ok('Ab1!xyz')).toBe(false); // too short
    expect(ok('Abcdefghijk1')).toBe(false); // no symbol
    expect(ok('Abcdefghijk!')).toBe(false); // no digit
    expect(ok('abcdefghij1!')).toBe(false); // no uppercase
    expect(ok('ABCDEFGHIJ1!')).toBe(false); // no lowercase
    expect(ok('Aa1!' + 'x'.repeat(69))).toBe(false); // 73 chars
    expect(ok('My-PASSWORD-9x!Zq')).toBe(false); // contains "password"
  });
});
