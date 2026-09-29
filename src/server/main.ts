import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDB } from './db.js';
import { createApp } from './http.js';
import { installSeed } from './seed.js';
import { getHeadRevisionId } from './query.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

function arg(flag: string, fallback: string): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const host = arg('--host', '127.0.0.1');
const port = Number(arg('--port', '5213'));
const dbPath = process.env.EVIDENCE_DB ?? resolve(root, 'data', 'evidence.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDB(dbPath);
if (getHeadRevisionId(db) === null) {
  await installSeed(db);
  console.log('[evidence] 已安装预置示例（跨午夜 / 时钟跳变 / 冲突 ID）');
}

const vite = await createViteServer({
  root: resolve(root, 'src/web'),
  server: { host, port, middlewareMode: true },
  appType: 'spa',
  logLevel: 'info'
});

const middleware = [
  async (req: IncomingMessage, res: ServerResponse) => {
    return new Promise<boolean>((resolve) => {
      vite.middlewares(req, res, () => resolve(res.writableEnded));
    });
  }
];

const server = createApp(db, middleware);
server.listen(port, host, () => {
  console.log(`[evidence] 事件证据拼图: http://${host}:${port}/`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
