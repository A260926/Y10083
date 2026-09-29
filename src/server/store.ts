import type { DatabaseSync } from 'node:sqlite';
import {
  ALGO_VERSION,
  type CanonicalEvent,
  type EventRecord,
  type QuarantineItem,
  type Receipt,
  type TimelineRow
} from '../shared/types.js';
import { sha256Bytes, sha256Hex, canonicalJson, canonicalizePayload } from '../shared/digest.js';
import { anchorViewFrom, buildSourceModel, correctObserved, parseObserved } from '../shared/time.js';
import type { AnchorView } from '../shared/types.js';

export interface ImportLineResult {
  ok: boolean;
  lineIndex: number | null;
  eventKey?: string;
  mergedReceipt?: boolean;
  conflict?: boolean;
  reason?: string;
}

export interface RevisionSnapshot {
  revisionId: string;
  parentId: string | null;
  basedOn: string | null;
  anchorDigest: string;
  anchors: AnchorView[];
  algoVersion: string;
  createdAt: string;
  note: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function archiveRaw(db: DatabaseSync, source: string, rawText: string, receivedAt: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawText);
  const rawDigest = await sha256Bytes(bytes);
  db.prepare(
    `INSERT OR IGNORE INTO raw_archive (raw_digest, source, received_at, raw_text, bytes_length)
     VALUES (?, ?, ?, ?, ?)`
  ).run(rawDigest, source, receivedAt, rawText, bytes.length);
  return rawDigest;
}

export function quarantineLine(
  db: DatabaseSync,
  source: string,
  receivedAt: string,
  rawLine: string,
  reason: string,
  lineIndex: number | null,
  quarantineId?: string
): string {
  const id = quarantineId ?? idFor('q', rawLine, source, reason);
  db.prepare(
    `INSERT OR IGNORE INTO quarantine (quarantine_id, source, received_at, raw_text, reason, line_index)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, source, receivedAt, rawLine, reason, lineIndex);
  return id;
}

function idFor(prefix: string, ...parts: (string | number)[]): string {
  const joined = parts.join('|');
  let h = 2166136261;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}_${(h >>> 0).toString(36)}`;
}

interface ParsedLine {
  canonical: CanonicalEvent;
  contentDigest: string;
}

async function parseAndDigest(rawLine: string): Promise<ParsedLine> {
  let json: unknown;
  try {
    json = JSON.parse(rawLine);
  } catch (err) {
    throw new Error(`JSON 解析失败: ${(err as Error).message}`);
  }
  const { canonical } = canonicalizePayload(json);
  parseObserved(canonical.observedAt);
  const contentDigest = await sha256Hex(canonicalJson(canonical));
  return { canonical, contentDigest };
}

function upsertEvent(db: DatabaseSync, canonical: CanonicalEvent, contentDigest: string, source: string, createdAt: string): string {
  const eventKey = `evt_${canonical.id}`;
  const existing = db.prepare('SELECT event_key, primary_source FROM events WHERE event_key = ?').get(eventKey) as
    | { event_key: string; primary_source: string }
    | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO events (event_key, id, canonical_json, content_digest, primary_source, conflict, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).run(eventKey, canonical.id, canonicalJson(canonical), contentDigest, source, createdAt);
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO event_variants (event_key, content_digest, canonical_json, created_at)
       SELECT ?, ?, canonical_json, ? FROM events WHERE event_key = ? AND content_digest != ?`
    ).run(eventKey, contentDigest, createdAt, eventKey, contentDigest);
  }

  db.prepare(
    `INSERT OR IGNORE INTO event_variants (event_key, content_digest, canonical_json, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(eventKey, contentDigest, canonicalJson(canonical), createdAt);

  const conflictRow = db
    .prepare('SELECT COUNT(*) AS c FROM event_variants WHERE event_key = ?')
    .get(eventKey) as { c: number };
  db.prepare('UPDATE events SET conflict = ? WHERE event_key = ?').run(conflictRow.c > 1 ? 1 : 0, eventKey);

  const sources = (
    db.prepare('SELECT DISTINCT source FROM receipts WHERE event_key = ? ORDER BY source').all(eventKey) as {
      source: string;
    }[]
  ).map((r) => r.source);
  if (!sources.includes(source)) sources.push(source);
  sources.sort();
  db.prepare('UPDATE events SET primary_source = ? WHERE event_key = ?').run(sources[0], eventKey);

  return eventKey;
}

function addReceipt(
  db: DatabaseSync,
  eventKey: string,
  contentDigest: string,
  receipt: Receipt,
  createdAt: string
): boolean {
  const receiptKey = idFor('rcp', eventKey, receipt.source, receipt.rawDigest);
  const existing = db
    .prepare('SELECT receipt_key FROM receipts WHERE receipt_key = ?')
    .get(receiptKey) as { receipt_key: string } | undefined;
  if (existing) {
    db.prepare('UPDATE receipts SET received_at = ? WHERE receipt_key = ?').run(receipt.receivedAt, receiptKey);
    return true;
  }
  db.prepare(
    `INSERT INTO receipts (receipt_key, event_key, content_digest, source, received_at, raw_digest, line_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    receiptKey,
    eventKey,
    contentDigest,
    receipt.source,
    receipt.receivedAt,
    receipt.rawDigest,
    receipt.lineIndex,
    createdAt
  );
  return false;
}

export async function importOne(
  db: DatabaseSync,
  source: string,
  rawLine: string,
  receivedAt: string,
  lineIndex: number | null,
  quarantineId?: string
): Promise<ImportLineResult> {
  const rawDigest = await archiveRaw(db, source, rawLine, receivedAt);
  let parsed: ParsedLine;
  try {
    parsed = await parseAndDigest(rawLine);
  } catch (err) {
    quarantineLine(db, source, receivedAt, rawLine, (err as Error).message, lineIndex, quarantineId);
    return { ok: false, lineIndex, reason: (err as Error).message };
  }

  const createdAt = nowIso();
  const eventKey = upsertEvent(db, parsed.canonical, parsed.contentDigest, source, createdAt);
  const mergedReceipt = addReceipt(
    db,
    eventKey,
    parsed.contentDigest,
    { source, receivedAt, rawDigest, lineIndex },
    createdAt
  );
  const ev = db.prepare('SELECT conflict FROM events WHERE event_key = ?').get(eventKey) as { conflict: number };
  return { ok: true, lineIndex, eventKey, mergedReceipt, conflict: ev.conflict === 1 };
}

export interface BatchReport {
  accepted: ImportLineResult[];
  rejected: ImportLineResult[];
}

export async function importBatch(db: DatabaseSync, source: string, ndjson: string, receivedAt = nowIso()): Promise<BatchReport> {
  const lines = ndjson.split(/\r?\n/);
  const accepted: ImportLineResult[] = [];
  const rejected: ImportLineResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.trim() === '') continue;
    const result = await importOne(db, source, rawLine, receivedAt, i + 1);
    (result.ok ? accepted : rejected).push(result);
  }
  return { accepted, rejected };
}
