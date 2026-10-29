import { createApp } from './app';
import { config } from './config';
import { prisma } from './db';

const server = createApp().listen(config.PORT, () => {
  console.log(`API listening on :${config.PORT} (docs at /docs)`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
  });
}
