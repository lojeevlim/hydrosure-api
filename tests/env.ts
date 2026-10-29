// Runs before any test module is imported, so config.ts sees test settings.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://hydrosure:hydrosure@localhost:5432/hydrosure_test?schema=public';
process.env.JWT_ACCESS_SECRET ||= 'test-secret-test-secret-test-secret-1234';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.GOOGLE_CLIENT_ID ||= 'test-client-id.apps.googleusercontent.com';
