import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.js';
import { createRevision, replayRevisionTimeline } from './revisions.js';
import { buildExport } from './export.js';
import { replayBundle, wipeDatabase } from './replay.js';
import { seedStore } from './seed.js';
import type { AnchorSnapshot, Confidence } from './types.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 32 * 1024 * 1024) throw new Error('请求体超过 32MB 限制');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function statePayload(store: Store) {
  return {
    sources: store.listSources(),
    anchors: store.listAnchors(),
    revisions: store.listRevisions(),
    hypotheses: store.listHypotheses(),
    quarantine_count: store.listQuarantine().length,
  };
}

function normalizeAnchors(raw: any): AnchorSnapshot[] {
  if (!Array.isArray(raw)) throw new Error('anchors 必须是数组');
  return raw.map((a: any) => {
    const sourceId = String(a.source_id ?? a.sourceId ?? '');
    const observed = toMs(a.observed_at_ms ?? a.observed_at);
    const trueAt = toMs(a.true_at_ms ?? a.true_at);
    if (!sourceId) throw new Error('锚点缺少 source_id');
    if (observed === null || trueAt === null) throw new Error('锚点时间无法解析');
    return {
      source_id: sourceId,
      observed_at_ms: observed,
      true_at_ms: trueAt,
      note: typeof a.note === 'string' ? a.note : '',
    };
  });
}

function toMs(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isInteger(n) ? n : Math.round(n * 1000);
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export async function handleApi(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && pathname === '/api/state') {
      send(res, 200, statePayload(store));
      return true;
    }
    if (method === 'GET' && pathname === '/api/events') {
      send(res, 200, { events: store.listEventsWithReceipts() });
      return true;
    }
    if (method === 'GET' && pathname === '/api/quarantine') {
      send(res, 200, { quarantine: store.listQuarantine() });
      return true;
    }
    if (method === 'GET' && pathname.startsWith('/api/timeline')) {
      const match = pathname.match(/^\/api\/timeline\/(\d+)$/);
      if (!match) {
        send(res, 404, { error: 'NOT_FOUND', message: '使用 /api/timeline/:revisionId' });
        return true;
      }
      const result = replayRevisionTimeline(store, Number(match[1])) as any;
      if (!result) {
        send(res, 404, { error: 'NOT_FOUND', message: '修订不存在' });
        return true;
      }
      const byId = new Map(result.liveOrder.map((i: any) => [i.event_id, i]));
      const items = result.storedOrder
        .map((row: any) => {
          const live = byId.get(row.event_id);
          return live ? { ...live, tie_group: row.tie_group, tie_size: row.tie_size } : null;
        })
        .filter(Boolean);
      send(res, 200, {
        revision: {
          id: result.revision.id,
          label: result.revision.label,
          algo_version: result.revision.algo_version,
          anchors_signature: result.revision.anchors_signature,
          anchors: result.revision.anchors,
          base_revision_id: result.revision.base_revision_id,
          created_at_ms: result.revision.created_at_ms,
        },
        items,
      });
      return true;
    }
    if (method === 'POST' && pathname === '/api/import') {
      const body = await readJson(req);
      const text = typeof body.ndjson === 'string' ? body.ndjson : '';
      if (!text.trim()) {
        send(res, 400, { error: 'BAD_REQUEST', message: 'ndjson 字段为空' });
        return true;
      }
      const defaultSource = typeof body.source === 'string' ? body.source : undefined;
      send(res, 200, { result: store.importLines(text, defaultSource) });
      return true;
    }
    if (method === 'POST' && pathname === '/api/events') {
      const body = await readJson(req);
      const text = typeof body.event === 'string' ? body.event : JSON.stringify(body.event ?? body);
      send(res, 200, { result: store.importLines(text, typeof body.source === 'string' ? body.source : undefined) });
      return true;
    }
    if (method === 'POST' && pathname === '/api/anchors') {
      const body = await readJson(req);
      const sourceId = String(body.source_id ?? '');
      const observed = toMs(body.observed_at_ms ?? body.observed_at);
      const trueAt = toMs(body.true_at_ms ?? body.true_at);
      if (!sourceId || observed === null || trueAt === null) {
        send(res, 400, { error: 'BAD_REQUEST', message: '需要 source_id、observed_at_ms、true_at_ms' });
        return true;
      }
      const anchor = store.addAnchor(sourceId, observed, trueAt, String(body.note ?? ''));
      send(res, 201, { anchor });
      return true;
    }
    if (method === 'POST' && pathname === '/api/revisions') {
      const body = await readJson(req);
      const anchors = normalizeAnchors(body.anchors ?? []);
      const outcome = createRevision(store, {
        label: String(body.label ?? `修订 @ ${new Date().toISOString()}`),
        anchors,
        baseRevisionId: body.base_revision_id ?? body.expected_previous_revision_id ?? null,
        expectedPreviousRevisionId:
          body.expected_previous_revision_id ?? body.base_revision_id ?? null,
      });
      send(res, outcome.status, outcome);
      return true;
    }
    if (method === 'POST' && pathname === '/api/hypotheses') {
      const body = await readJson(req);
      const confidence = String(body.confidence ?? 'low') as Confidence;
      if (!['low', 'medium', 'high'].includes(confidence)) {
        send(res, 400, { error: 'BAD_REQUEST', message: 'confidence 必须是 low/medium/high' });
        return true;
      }
      const eventIds = Array.isArray(body.event_ids) ? body.event_ids.map(String) : [];
      const hypothesis = store.addHypothesis(
        String(body.title ?? ''),
        String(body.basis ?? ''),
        confidence,
        eventIds,
      );
      send(res, 201, { hypothesis });
      return true;
    }
    if (method === 'GET' && pathname === '/api/export') {
      send(res, 200, buildExport(store));
      return true;
    }
    if (method === 'POST' && pathname === '/api/replay') {
      const bundle = await readJson(req);
      const result = replayBundle(store, bundle);
      send(res, 200, { ok: true, result });
      return true;
    }
    if (method === 'POST' && pathname === '/api/reset') {
      wipeDatabase(store);
      send(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && pathname === '/api/seed') {
      seedStore(store);
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  } catch (err) {
    send(res, 400, { error: 'BAD_REQUEST', message: (err as Error).message });
    return true;
  }
}
