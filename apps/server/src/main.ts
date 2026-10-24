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
const voices = (app as unknown as { ttsVoices: { zh: string; en: string } | null }).ttsVoices;
console.log(voices ? `朗读用这台 Mac 的语音：中文 ${voices.zh}，英文 ${voices.en}（家长端「设备与数据 → 朗读声音」可以试听和更换）` : '没找到这台机器的中文语音，Pad 会改用 iPad 自带语音。');
if (!voices || !/\((Premium|Enhanced)\)/.test(`${voices.zh} ${voices.en}`)) console.log('想要更像真人的声音：Mac 上打开 系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，下载中文“Lilian（高级）”或“婷婷（增强）”、英文“Ava（高级）”或“Zoe（高级）”，然后重启服务。');
