import { sha256Hex } from './crypto.js';
import { canonicalStable, anchorSignature } from './clock.js';
import { buildTimeline } from './timeline.js';
import type { Store } from './store.js';

export type ManifestPartial = {
  generated_at_ms: number;
  algorithm: string;
  hashes: Record<string, string>;
  sort_signature: Record<string, string>;
};

export function computeManifestTotal(data: ExportBundle['data'], partial: ManifestPartial): string {
  return sha256Hex(canonicalStable({ data, manifest: partial }));
}

export interface ExportBundle {
  format: 'event-evidence-puzzle';
  version: 1;
  exported_at_ms: number;
  data: {
    sources: Array<{ id: string; name: string; kind: string; created_at_ms: number }>;
    events: Array<{
      id: string;
      content_canonical: string;
      content_sha: string;
      summary: string;
      conflict: boolean;
    }>;
    receipts: Array<{
      id: number;
      event_id: string;
      source_id: string;
      raw_text: string;
      raw_sha: string;
      observed_at_ms: number | null;
      received_at_ms: number;
      batch_id: number | null;
      line_no: number | null;
    }>;
    quarantine: Array<{
      id: number;
      batch_id: number | null;
      line_no: number | null;
      source_id: string | null;
      raw_text: string;
      raw_sha: string;
      reason: string;
      received_at_ms: number;
    }>;
    anchors: Array<{
      id: number;
      source_id: string;
      observed_at_ms: number;
      true_at_ms: number;
      note: string;
      created_at_ms: number;
    }>;
    revisions: Array<{
      id: number;
      label: string;
      algo_version: string;
      anchors: any[];
      anchors_signature: string;
      base_revision_id: number | null;
      created_at_ms: number;
      order: Array<{
        event_id: string;
        corr_ms: number | null;
        half_width_ms: number | null;
        lo_ms: number | null;
        hi_ms: number | null;
        tie_group: number | null;
        tie_size: number;
      }>;
    }>;
    hypotheses: Array<{
      id: number;
      title: string;
      basis: string;
      confidence: string;
      created_at_ms: number;
      event_ids: string[];
    }>;
  };
  manifest: {
    generated_at_ms: number;
    algorithm: string;
    hashes: Record<string, string>;
    sort_signature: Record<string, string>;
    total_manifest_sha256: string;
  };
}

export function buildExport(store: Store): ExportBundle {
  const sources = store.prepare('SELECT id, name, kind, created_at_ms FROM source ORDER BY id').all();
  const events = store.prepare('SELECT * FROM event ORDER BY id').all().map((e: any) => ({
    id: e.id,
    content_canonical: e.content_canonical,
    content_sha: e.content_sha,
    summary: e.summary,
    conflict: e.conflict === 1,
  }));
  const receipts = store.prepare('SELECT * FROM receipt ORDER BY id').all().map((r: any) => ({
    id: r.id,
    event_id: r.event_id,
    source_id: r.source_id,
    raw_text: r.raw_text,
    raw_sha: r.raw_sha,
    observed_at_ms: r.observed_at_ms,
    received_at_ms: r.received_at_ms,
    batch_id: r.batch_id,
    line_no: r.line_no,
  }));
  const quarantine = store.prepare('SELECT * FROM quarantine ORDER BY id').all().map((q: any) => ({
    id: q.id,
    batch_id: q.batch_id,
    line_no: q.line_no,
    source_id: q.source_id,
    raw_text: q.raw_text,
    raw_sha: q.raw_sha,
    reason: q.reason,
    received_at_ms: q.received_at_ms,
  }));
  const anchors = store.prepare('SELECT * FROM anchor ORDER BY id').all().map((a: any) => ({
    id: a.id,
    source_id: a.source_id,
    observed_at_ms: a.observed_at_ms,
    true_at_ms: a.true_at_ms,
    note: a.note,
    created_at_ms: a.created_at_ms,
  }));
  const revisionsRaw = store.prepare('SELECT * FROM revision ORDER BY id').all();
  const sourceList = sources.map((s: any) => ({ id: s.id, name: s.name }));
  const revisions = revisionsRaw.map((rev: any) => {
    const anchorList = JSON.parse(rev.anchors_json);
    const timeline = buildTimeline(store.listEventsWithReceipts(), sourceList, anchorList);
    const byId = new Map(timeline.map((t) => [t.event_id, t]));
    const stored = store
      .prepare('SELECT * FROM revision_event WHERE revision_id = ? ORDER BY seq')
      .all(rev.id)
      .map((r: any) => ({
        event_id: r.event_id,
        corr_ms: r.corr_ms,
        half_width_ms: r.half_width_ms,
        lo_ms: r.lo_ms,
        hi_ms: r.hi_ms,
        tie_group: r.tie_group,
        tie_size: r.tie_size,
        live: byId.get(r.event_id) ?? null,
      }));
    for (const row of stored) {
      if (!row.live) throw new Error(`导出校验失败：修订 #${rev.id} 缺少事件 ${row.event_id}`);
      const live = row.live;
      if (
        live.corr_ms !== row.corr_ms ||
        live.half_width_ms !== row.half_width_ms ||
        live.lo_ms !== row.lo_ms ||
        live.hi_ms !== row.hi_ms ||
        (live.tie_group ?? null) !== (row.tie_group ?? null) ||
        live.tie_size !== row.tie_size
      ) {
        throw new Error(`导出校验失败：修订 #${rev.id} 事件 ${row.event_id} 的校正结果与存储不一致`);
      }
    }
    return {
      id: rev.id,
      label: rev.label,
      algo_version: rev.algo_version,
      anchors: anchorList,
      anchors_signature: rev.anchors_signature,
      base_revision_id: rev.base_revision_id,
      created_at_ms: rev.created_at_ms,
      order: stored.map((row: any) => ({
        event_id: row.event_id,
        corr_ms: row.corr_ms,
        half_width_ms: row.half_width_ms,
        lo_ms: row.lo_ms,
        hi_ms: row.hi_ms,
        tie_group: row.tie_group,
        tie_size: row.tie_size,
      })),
    };
  });
  const hypotheses = store.listHypotheses().map((h) => ({
    id: h.id,
    title: h.title,
    basis: h.basis,
    confidence: h.confidence,
    created_at_ms: (h as any).created_at_ms,
    event_ids: h.event_ids,
  }));

  const data = { sources, events, receipts, quarantine, anchors, revisions, hypotheses };
  const hashes: Record<string, string> = {};
  for (const key of ['sources', 'events', 'receipts', 'quarantine', 'anchors', 'hypotheses'] as const) {
    hashes[key] = sha256Hex(canonicalStable(data[key]));
  }
  const sortSignature: Record<string, string> = {};
  for (const rev of data.revisions) {
    const expectedAnchorSig = anchorSignature(rev.anchors);
    if (expectedAnchorSig !== rev.anchors_signature) {
      throw new Error(`导出校验失败：修订 #${rev.id} 锚点签名不匹配`);
    }
    sortSignature[String(rev.id)] = sha256Hex(
      canonicalStable({
        anchors_signature: rev.anchors_signature,
        algo: rev.algo_version,
        order: rev.order,
      }),
    );
  }
  const now = Date.now();
  const partial: ManifestPartial = {
    generated_at_ms: now,
    algorithm: 'piecewise-linear-v1',
    hashes,
    sort_signature: sortSignature,
  };
  const total = computeManifestTotal(data, partial);
  return {
    format: 'event-evidence-puzzle',
    version: 1,
    exported_at_ms: now,
    data,
    manifest: { ...partial, total_manifest_sha256: total },
  };
}
