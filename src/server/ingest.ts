import { canonicalStable, parseTimeMs } from './clock.js';
import { sha256Hex } from './crypto.js';

export interface ParsedLine {
  eventId: string;
  sourceId: string;
  sourceName?: string;
  sourceKind?: string;
  observedAtMs: number | null;
  content: unknown;
  contentCanonical: string;
  contentSha: string;
  summary: string;
}

export interface ParseFailure {
  reason: string;
}

export function buildSummary(content: unknown): string {
  if (content === null || typeof content !== 'object') return canonicalStable(content);
  const obj = content as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['type', 'kind', 'level', 'message', 'msg', 'op', 'action']) {
    if (obj[key] !== undefined) {
      const text = typeof obj[key] === 'string' ? obj[key] : canonicalStable(obj[key]);
      parts.push(String(text));
    }
  }
  const joined = parts.join(' ').trim();
  const canonical = canonicalStable(content);
  return joined.length > 0 ? joined : canonical;
}

export function parseEventLine(line: string): ParsedLine | ParseFailure {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    return { reason: `不是合法 JSON：${(err as Error).message}` };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { reason: '事件必须是 JSON 对象' };
  }
  const rec = obj as Record<string, unknown>;
  const eventId = rec.event_id ?? rec.eventId ?? rec.id;
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    return { reason: '缺少字符串字段 event_id' };
  }
  const source = rec.source ?? rec.source_id ?? rec.sourceId;
  let sourceId: string;
  if (typeof source === 'string' && source.trim() !== '') {
    sourceId = source;
  } else if (source && typeof source === 'object' && typeof (source as Record<string, unknown>).id === 'string') {
    sourceId = (source as Record<string, unknown>).id as string;
  } else {
    return { reason: '缺少字符串字段 source（来源标识）' };
  }
  const sourceMeta =
    source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  const observedRaw = rec.observed_at ?? rec.observedAt ?? rec.ts ?? rec.timestamp ?? null;
  const observedAtMs = parseTimeMs(observedRaw);
  if (observedRaw !== null && observedRaw !== undefined && observedRaw !== '' && observedAtMs === null) {
    return { reason: `时间字段无法解析：${String(observedRaw)}` };
  }
  const content = rec.content !== undefined ? rec.content : rec;
  const contentCanonical = canonicalStable(content);
  const contentSha = sha256Hex(contentCanonical);
  const summary = buildSummary(content);
  return {
    eventId,
    sourceId,
    sourceName: typeof sourceMeta.name === 'string' ? sourceMeta.name : undefined,
    sourceKind: typeof sourceMeta.kind === 'string' ? sourceMeta.kind : undefined,
    observedAtMs,
    content,
    contentCanonical,
    contentSha,
    summary,
  };
}

export function splitNdjson(input: string): Array<{ lineNo: number; text: string }> {
  return input
    .split(/\r?\n/)
    .map((text, idx) => ({ lineNo: idx + 1, text }))
    .filter((l) => l.text.trim() !== '');
}
