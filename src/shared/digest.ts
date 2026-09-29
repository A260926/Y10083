import type { CanonicalEvent, EventPayload, ExportBundle } from './types.js';

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalizePayload(input: unknown): { canonical: CanonicalEvent; raw: EventPayload } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('事件必须是 JSON 对象');
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    throw new Error('事件缺少字符串字段 id');
  }
  if (obj.observedAt === undefined || obj.observedAt === null) {
    throw new Error('事件缺少 observedAt 字段');
  }
  if (typeof obj.observedAt !== 'string' && typeof obj.observedAt !== 'number') {
    throw new Error('observedAt 必须是字符串或数字');
  }
  const canonical: CanonicalEvent = {
    id: obj.id,
    type: typeof obj.type === 'string' && obj.type.trim() !== '' ? obj.type : 'event',
    observedAt: typeof obj.observedAt === 'number' ? String(obj.observedAt) : (obj.observedAt as string),
    detail: obj.detail === undefined ? null : obj.detail
  };
  return { canonical, raw: { id: obj.id, type: canonical.type, observedAt: obj.observedAt as string | number, detail: canonical.detail } };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortValue(v)])
    );
  }
  return value;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

export interface BundleBody {
  format: ExportBundle['format'];
  exportedAt: string;
  events: ExportBundle['events'];
  revisions: ExportBundle['revisions'];
  hypotheses: ExportBundle['hypotheses'];
  quarantine: ExportBundle['quarantine'];
}

export function bundleBodyDigest(body: BundleBody): Promise<string> {
  return sha256Hex(canonicalJson(body));
}
