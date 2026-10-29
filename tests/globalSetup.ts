import { execSync } from 'node:child_process';

export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://hydrosure:hydrosure@localhost:5432/hydrosure_test?schema=public';
  // Creates the test database if missing and applies all migrations.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
