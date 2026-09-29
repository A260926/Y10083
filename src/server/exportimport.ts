import type { DatabaseSync } from 'node:sqlite';
import type { ExportBundle, Hypothesis, QuarantineItem, Revision } from '../shared/types.js';
import { canonicalJson, bundleBodyDigest } from '../shared/digest.js';
import { listEvents } from './query.js';
import { listHypotheses } from './hypotheses.js';
import { listQuarantine, listRevisions } from './query.js';
import { importOne, quarantineLine } from './store.js';

interface RawArchiveEntry {
  rawDigest: string;
  source: string;
  receivedAt: string;
  rawText: string;
  bytesLength: number;
}

export async function buildBundle(db: DatabaseSync): Promise<ExportBundle> {
  const events = listEvents(db).map((event) => ({
    eventKey: event.eventKey,
    canonical: event.canonical,
    contentDigest: event.contentDigest,
    primarySource: event.primarySource,
    receipts: event.receipts,
    conflict: event.conflict
  }));
  const revisions = listRevisions(db);
  const hypotheses = listHypotheses(db);
  const quarantine = listQuarantine(db);
  const rawArchive = (
    db
      .prepare('SELECT raw_digest, source, received_at, raw_text, bytes_length FROM raw_archive ORDER BY raw_digest')
      .all() as {
      raw_digest: string;
      source: string;
      received_at: string;
      raw_text: string;
      bytes_length: number;
    }[]
  ).map((r) => ({
    rawDigest: r.raw_digest,
    source: r.source,
    receivedAt: r.received_at,
    rawText: r.raw_text,
    bytesLength: r.bytes_length
  }));

  const exportedAt = new Date().toISOString();
  const body = {
    format: 'event-evidence-puzzle/v1' as const,
    exportedAt,
    events,
    revisions,
    hypotheses,
    quarantine,
    rawArchive
  };
  const bodyDigest = await bundleBodyDigest(body);
  const anchorsPerRevision: Record<string, number> = {};
  for (const revision of revisions) anchorsPerRevision[revision.revisionId] = revision.anchors.length;
  return {
    ...body,
    manifest: {
      bodyDigest,
      counts: {
        events: events.length,
        receipts: events.reduce((sum, e) => sum + e.receipts.length, 0),
        revisions: revisions.length,
        hypotheses: hypotheses.length,
        quarantine: quarantine.length
      },
      anchorsPerRevision
    }
  };
}

export class ManifestError extends Error {}

async function verifyBundle(bundle: unknown): Promise<ExportBundle & { rawArchive: RawArchiveEntry[] }> {
  if (typeof bundle !== 'object' || bundle === null) throw new ManifestError('导出包不是对象');
  const b = bundle as ExportBundle & { rawArchive?: RawArchiveEntry[]; manifest?: ExportBundle['manifest'] };
  if (b.format !== 'event-evidence-puzzle/v1') throw new ManifestError('format 不匹配');
  if (!b.manifest?.bodyDigest) throw new ManifestError('缺少 manifest.bodyDigest');
  if (!Array.isArray(b.rawArchive)) throw new ManifestError('缺少 rawArchive');
  const allowed = new Set(['format', 'exportedAt', 'events', 'revisions', 'hypotheses', 'quarantine', 'rawArchive', 'manifest']);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) throw new ManifestError(`manifest 校验失败：存在未声明字段 ${key}`);
  }
  const { manifest, ...rest } = b;
  void manifest;
  const digest = await bundleBodyDigest(rest as Parameters<typeof bundleBodyDigest>[0]);
  if (digest !== b.manifest.bodyDigest) {
    throw new ManifestError('manifest 校验失败：内容摘要不一致，导出包可能被改动');
  }
  return b as ExportBundle & { rawArchive: RawArchiveEntry[] };
}

export interface ReplayReport {
  imported: number;
  mergedReceipts: number;
  conflicts: string[];
  quarantine: number;
  revisions: number;
  hypotheses: number;
}

export async function replayBundle(db: DatabaseSync, bundle: unknown): Promise<ReplayReport> {
  const verified = await verifyBundle(bundle);
  const rawByDigest = new Map(verified.rawArchive.map((r) => [r.rawDigest, r]));

  let imported = 0;
  let mergedReceipts = 0;
  const conflicts = new Set<string>();

  for (const event of verified.events) {
    for (const receipt of event.receipts) {
      const raw = rawByDigest.get(receipt.rawDigest);
      if (!raw) throw new ManifestError(`收据引用的原始字节缺失: ${receipt.rawDigest}`);
      const result = await importOne(db, receipt.source, raw.rawText, receipt.receivedAt, receipt.lineIndex);
      if (result.ok) {
        imported += 1;
        if (result.mergedReceipt) mergedReceipts += 1;
        if (result.conflict) conflicts.add(event.eventKey);
      } else {
        throw new ManifestError(`合法事件在重放时解析失败: ${event.eventKey}`);
      }
    }
  }

  for (const item of verified.quarantine as QuarantineItem[]) {
    quarantineLine(db, item.source, item.receivedAt, item.rawLine, item.reason, item.lineIndex, item.quarantineId);
  }

  let revisions = 0;
  for (const revision of verified.revisions as Revision[]) {
    db.prepare(
      `INSERT OR IGNORE INTO revisions (revision_id, parent_id, based_on, anchor_digest, anchors_json, algo_version, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      revision.revisionId,
      revision.parentId,
      revision.basedOn,
      revision.anchorDigest,
      canonicalJson(revision.anchors),
      revision.algoVersion,
      revision.createdAt,
      revision.note
    );
    revisions += 1;
  }

  let hypotheses = 0;
  for (const hypothesis of verified.hypotheses as Hypothesis[]) {
    db.prepare(
      'INSERT OR IGNORE INTO hypotheses (hypothesis_id, title, evidence, confidence_note, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(hypothesis.hypothesisId, hypothesis.title, hypothesis.evidence, hypothesis.confidenceNote, hypothesis.createdAt);
    for (const key of hypothesis.eventKeys) {
      db.prepare('INSERT OR IGNORE INTO hypothesis_events (hypothesis_id, event_key) VALUES (?, ?)').run(
        hypothesis.hypothesisId,
        key
      );
    }
    hypotheses += 1;
  }

  return { imported, mergedReceipts, conflicts: [...conflicts].sort(), quarantine: verified.quarantine.length, revisions, hypotheses };
}
