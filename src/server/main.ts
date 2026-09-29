import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { Store } from './store.js';
import { handleApi } from './api.js';
import { seedIfNeeded } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

function parseArgs(argv: string[]): { host: string; port: number } {
  let host = '127.0.0.1';
  let port = 5213;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') host = argv[++i] ?? host;
    else if (arg === '--port') port = Number(argv[++i] ?? port);
    else if (arg?.startsWith('--port=')) port = Number(arg.slice('--port='.length));
    else if (arg?.startsWith('--host=')) host = arg.slice('--host='.length);
  }
  return { host, port };
}

async function main(): Promise<void> {
  const { host, port } = parseArgs(process.argv.slice(2));
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const store = await Store.open(path.join(dataDir, 'evidence.sqlite'));
  const seeded = seedIfNeeded(store);

  const vite = await createViteServer({
    configFile: path.join(rootDir, 'vite.config.ts'),
    server: { middlewareMode: true, host, port },
    appType: 'spa',
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(store, req, res, url.pathname).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL', message: String(err?.message ?? err) }));
      });
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`事件证据拼图 已启动：http://${host}:${port}${seeded ? '（已载入预置示例）' : ''}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
