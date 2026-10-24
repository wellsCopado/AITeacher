// Start the family server: ADW_PIN=xxxx pnpm start   (see docs/deploy.md)
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dbPath = process.env.ADW_DB ?? join(root, 'data', 'adw.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const app = await buildApp({ root, dbPath, pin: process.env.ADW_PIN ?? '', tenant: process.env.ADW_TENANT, serveApps: true, logger: true });
const port = Number(process.env.PORT ?? 8787);
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
console.log(`孩子的 Pad 打开 http://<这台机器的地址>:${port}/pad/ ，家长端 http://<这台机器的地址>:${port}/parent/`);
