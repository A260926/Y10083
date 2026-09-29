import { sha256Hex } from './crypto.js';
import { anchorSignature, canonicalStable } from './clock.js';
import type { Store } from './store.js';
import { computeManifestTotal, type ExportBundle, type ManifestPartial } from './export.js';
import { buildTimeline } from './timeline.js';

export interface ReplayResult {
  imported: {
    sources: number;
    events: number;
    receipts: number;
    quarantine: number;
    anchors: number;
    revisions: number;
    hypotheses: number;
  };
  verified: {
    manifest: boolean;
    sort_signatures: Array<{ revision_id: number; match: boolean }>;
    source_chain: { receipt_count: number; matched: number };
  };
}

export function verifyBundle(bundle: unknown): asserts bundle is ExportBundle {
  const b = bundle as Partial<ExportBundle>;
  if (!b || b.format !== 'event-evidence-puzzle' || b.version !== 1) {
    throw new Error('不是受支持的导出格式（format=event-evidence-puzzle, version=1）');
  }
  const d = b.data;
  const m = b.manifest;
  if (!d || !m) throw new Error('导出缺少 data 或 manifest 段');
  const { total_manifest_sha256: totalHash, ...partial } = m;
  if (computeManifestTotal(d, partial as ManifestPartial) !== totalHash) {
    throw new Error('manifest 校验失败：总哈希不一致，导出文件可能被改动');
  }
  for (const key of ['sources', 'events', 'receipts', 'quarantine', 'anchors', 'hypotheses'] as const) {
    const expected = m.hashes[key];
    const actual = sha256Hex(canonicalStable(d[key]));
    if (expected !== actual) {
      throw new Error(`manifest 校验失败：${key} 段哈希不一致`);
    }
  }
  for (const rev of d.revisions) {
    if (anchorSignature(rev.anchors) !== rev.anchors_signature) {
      throw new Error(`manifest 校验失败：修订 #${rev.id} 锚点集合被篡改`);
    }
    const expected = m.sort_signature[String(rev.id)];
    const actual = sha256Hex(
      canonicalStable({
        anchors_signature: rev.anchors_signature,
        algo: rev.algo_version,
        order: rev.order,
      }),
    );
    if (expected !== actual) {
      throw new Error(`manifest 校验失败：修订 #${rev.id} 排序签名不一致`);
    }
  }
}

export function wipeDatabase(store: Store): void {
  store.transaction(() => {
    store.exec(`
      DELETE FROM hypothesis_member;
      DELETE FROM hypothesis;
      DELETE FROM revision_event;
      DELETE FROM revision;
      DELETE FROM anchor;
      DELETE FROM quarantine;
      DELETE FROM receipt;
      DELETE FROM event_conflict;
      DELETE FROM event;
      DELETE FROM source;
      DELETE FROM batch;
      DELETE FROM sqlite_sequence;
    `);
  });
}

export function replayBundle(store: Store, bundle: ExportBundle): ReplayResult {
  verifyBundle(bundle);
  return store.transaction(() => {
    wipeDatabase(store);
    const d = bundle.data;
    const insSource = store.prepare(
      'INSERT INTO source (id, name, kind, created_at_ms) VALUES (?, ?, ?, ?)',
    );
    for (const s of d.sources) insSource.run(s.id, s.name, s.kind, s.created_at_ms);
    const insEvent = store.prepare(
      'INSERT INTO event (id, content_canonical, content_sha, summary, first_receipt_id, conflict) VALUES (?, ?, ?, ?, NULL, ?)',
    );
    for (const e of d.events) insEvent.run(e.id, e.content_canonical, e.content_sha, e.summary, e.conflict ? 1 : 0);
    const insBatch = store.prepare(
      'INSERT INTO batch (id, source_id, received_at_ms, accepted_count, rejected_count) VALUES (?, ?, ?, 0, 0)',
    );
    const batchIds = new Set<number>();
    for (const r of d.receipts) {
      if (r.batch_id !== null && !batchIds.has(r.batch_id)) {
        insBatch.run(r.batch_id, null, r.received_at_ms);
        batchIds.add(r.batch_id);
      }
    }
    const insReceipt = store.prepare(
      'INSERT INTO receipt (id, event_id, source_id, raw_text, raw_sha, observed_at_ms, received_at_ms, batch_id, line_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let matchedChain = 0;
    for (const r of d.receipts) {
      const rawShaActual = sha256Hex(Buffer.from(r.raw_text, 'utf8'));
      if (rawShaActual === r.raw_sha) matchedChain++;
      insReceipt.run(
        r.id,
        r.event_id,
        r.source_id,
        r.raw_text,
        r.raw_sha,
        r.observed_at_ms,
        r.received_at_ms,
        r.batch_id,
        r.line_no,
      );
    }
    const insQ = store.prepare(
      'INSERT INTO quarantine (id, batch_id, line_no, source_id, raw_text, raw_sha, reason, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const q of d.quarantine) {
      insQ.run(q.id, q.batch_id, q.line_no, q.source_id, q.raw_text, q.raw_sha, q.reason, q.received_at_ms);
    }
    const insAnchor = store.prepare(
      'INSERT INTO anchor (id, source_id, observed_at_ms, true_at_ms, note, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const a of d.anchors) {
      insAnchor.run(a.id, a.source_id, a.observed_at_ms, a.true_at_ms, a.note, a.created_at_ms);
    }
    const insRev = store.prepare(
      'INSERT INTO revision (id, label, algo_version, anchors_json, anchors_signature, base_revision_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insRevEvent = store.prepare(
      'INSERT INTO revision_event (revision_id, event_id, corr_ms, half_width_ms, lo_ms, hi_ms, tie_group, tie_size, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const sortCheck: Array<{ revision_id: number; match: boolean }> = [];
    for (const rev of d.revisions) {
      insRev.run(
        rev.id,
        rev.label,
        rev.algo_version,
        JSON.stringify(rev.anchors),
        rev.anchors_signature,
        rev.base_revision_id,
        rev.created_at_ms,
      );
      const recomputed = buildLiveOrder(store, rev.anchors);
      const match =
        recomputed.length === rev.order.length &&
        recomputed.every((item, idx) => {
          const saved = rev.order[idx];
          return (
            item.event_id === saved.event_id &&
            item.corr_ms === saved.corr_ms &&
            item.half_width_ms === saved.half_width_ms &&
            item.lo_ms === saved.lo_ms &&
            item.hi_ms === saved.hi_ms &&
            (item.tie_group ?? null) === (saved.tie_group ?? null) &&
            item.tie_size === saved.tie_size
          );
        });
      sortCheck.push({ revision_id: rev.id, match });
      rev.order.forEach((o, idx) => {
        insRevEvent.run(
          rev.id,
          o.event_id,
          o.corr_ms,
          o.half_width_ms,
          o.lo_ms,
          o.hi_ms,
          o.tie_group,
          o.tie_size,
          idx,
        );
      });
      if (!match) throw new Error(`重放校验失败：修订 #${rev.id} 重新计算的排序与导出不一致`);
    }
    const insHyp = store.prepare(
      'INSERT INTO hypothesis (id, title, basis, confidence, created_at_ms) VALUES (?, ?, ?, ?, ?)',
    );
    const insHypMember = store.prepare(
      'INSERT INTO hypothesis_member (hypothesis_id, event_id, seq) VALUES (?, ?, ?)',
    );
    for (const h of d.hypotheses) {
      insHyp.run(h.id, h.title, h.basis, h.confidence, h.created_at_ms);
      h.event_ids.forEach((eventId, idx) => insHypMember.run(h.id, eventId, idx));
    }
    return {
      imported: {
        sources: d.sources.length,
        events: d.events.length,
        receipts: d.receipts.length,
        quarantine: d.quarantine.length,
        anchors: d.anchors.length,
        revisions: d.revisions.length,
        hypotheses: d.hypotheses.length,
      },
      verified: {
        manifest: true,
        sort_signatures: sortCheck,
        source_chain: { receipt_count: d.receipts.length, matched: matchedChain },
      },
    };
  });
}

function buildLiveOrder(store: Store, anchors: any[]) {
  const sources = store.listSources().map((s) => ({ id: s.id, name: s.name }));
  return buildTimeline(store.listEventsWithReceipts(), sources, anchors);
}
