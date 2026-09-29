import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { buildTimeline, getHeadRevisionId, getRevision, listEvents, listQuarantine, listRevisions } from './query.js';
import { importBatch, importOne } from './store.js';
import { addHypothesis, listHypotheses } from './hypotheses.js';
import { createRevision } from './revisions.js';
import { buildBundle, replayBundle } from './exportimport.js';

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

export function createApp(db: DatabaseSync, middlewares: Array<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>> = []) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';

      if (url.pathname.startsWith('/api/')) {
        await handleApi(db, method, url, req, res);
        return;
      }

      for (const mw of middlewares) {
        if (await mw(req, res)) return;
      }

      send(res, 404, { error: 'not_found' });
    } catch (err) {
      send(res, 400, { error: 'bad_request', message: (err as Error).message });
    }
  });
}

async function handleApi(db: DatabaseSync, method: string, url: URL, req: IncomingMessage, res: ServerResponse) {
  const path = url.pathname;

  if (method === 'POST' && path === '/api/events/batch') {
    const body = (await readJson(req)) as { source?: string; ndjson?: string };
    if (!body.source || !body.ndjson) throw new Error('需要 source 与 ndjson 字段');
    const report = await importBatch(db, body.source, body.ndjson);
    send(res, 200, report);
    return;
  }

  if (method === 'POST' && path === '/api/events/one') {
    const body = (await readJson(req)) as { source?: string; raw?: string };
    if (!body.source || typeof body.raw !== 'string') throw new Error('需要 source 与 raw 字段');
    const result = await importOne(db, body.source, body.raw, new Date().toISOString(), null);
    send(res, result.ok ? 200 : 202, result);
    return;
  }

  if (method === 'GET' && path === '/api/events') {
    send(res, 200, { events: listEvents(db) });
    return;
  }

  if (method === 'GET' && path === '/api/timeline') {
    const revisionId = url.searchParams.get('revision') ?? getHeadRevisionId(db);
    const revision = revisionId ? getRevision(db, revisionId) : null;
    if (revisionId && !revision) throw new Error(`修订不存在: ${revisionId}`);
    send(res, 200, {
      revision,
      head: getHeadRevisionId(db),
      revisions: listRevisions(db).map((r) => ({ revisionId: r.revisionId, note: r.note, createdAt: r.createdAt })),
      rows: buildTimeline(db, revision)
    });
    return;
  }

  if (method === 'GET' && path === '/api/revisions') {
    send(res, 200, { revisions: listRevisions(db), head: getHeadRevisionId(db) });
    return;
  }

  if (method === 'POST' && path === '/api/revisions') {
    const body = (await readJson(req)) as { basedOn?: string | null; anchors?: unknown; note?: string };
    const result = await createRevision(db, {
      basedOn: body.basedOn === undefined ? getHeadRevisionId(db) : body.basedOn,
      anchors: body.anchors as never,
      note: body.note
    });
    send(res, result.status, result);
    return;
  }

  if (method === 'GET' && path === '/api/hypotheses') {
    send(res, 200, { hypotheses: listHypotheses(db) });
    return;
  }

  if (method === 'POST' && path === '/api/hypotheses') {
    const body = (await readJson(req)) as Parameters<typeof addHypothesis>[1];
    send(res, 201, { hypothesis: addHypothesis(db, body) });
    return;
  }

  if (method === 'GET' && path === '/api/quarantine') {
    send(res, 200, { quarantine: listQuarantine(db) });
    return;
  }

  if (method === 'GET' && path === '/api/export') {
    send(res, 200, await buildBundle(db));
    return;
  }

  if (method === 'POST' && path === '/api/replay') {
    const bundle = await readJson(req);
    send(res, 200, { report: await replayBundle(db, bundle) });
    return;
  }

  send(res, 404, { error: 'not_found', path });
}
