import { ALGO_VERSION, anchorSignature } from './clock.js';
import { buildTimeline } from './timeline.js';
import type { AnchorSnapshot } from './types.js';
import type { Store } from './store.js';

export interface CreateRevisionInput {
  label: string;
  anchors: AnchorSnapshot[];
  baseRevisionId?: number | null;
  expectedPreviousRevisionId?: number | null;
}

export interface AnchorDiff {
  source_id: string;
  observed_at_ms: number;
  requested_true_at_ms: number | null;
  latest_true_at_ms: number | null;
  true_delta_ms: number | null;
  requested_note?: string;
  latest_note?: string;
}

export interface CreateRevisionConflict {
  status: 409;
  error: 'REVISION_CONFLICT';
  message: string;
  requested_base_revision_id: number | null;
  latest_revision_id: number;
  anchor_diff: AnchorDiff[];
}

export type CreateRevisionOutcome =
  | { status: 201; revision: { id: number; label: string; created_at_ms: number } }
  | CreateRevisionConflict;

export function diffAnchors(requested: AnchorSnapshot[], latest: AnchorSnapshot[]): AnchorDiff[] {
  const key = (a: AnchorSnapshot) => `${a.source_id}|${a.observed_at_ms}`;
  const byLatest = new Map(latest.map((a) => [key(a), a]));
  const byRequested = new Map(requested.map((a) => [key(a), a]));
  const allKeys = new Set<string>([...byLatest.keys(), ...byRequested.keys()]);
  const out: AnchorDiff[] = [];
  for (const k of allKeys) {
    const req = byRequested.get(k);
    const lat = byLatest.get(k);
    const sourceId = (req ?? lat)!.source_id;
    const observed = (req ?? lat)!.observed_at_ms;
    const reqTrue = req?.true_at_ms ?? null;
    const latTrue = lat?.true_at_ms ?? null;
    out.push({
      source_id: sourceId,
      observed_at_ms: observed,
      requested_true_at_ms: reqTrue,
      latest_true_at_ms: latTrue,
      true_delta_ms: reqTrue !== null && latTrue !== null ? reqTrue - latTrue : null,
      requested_note: req?.note,
      latest_note: lat?.note,
    });
  }
  out.sort((a, b) =>
    a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : a.observed_at_ms - b.observed_at_ms,
  );
  return out;
}

export function createRevision(store: Store, input: CreateRevisionInput): CreateRevisionOutcome {
  const anchors = input.anchors.map((a) => ({
    source_id: a.source_id,
    observed_at_ms: a.observed_at_ms,
    true_at_ms: a.true_at_ms,
    note: a.note ?? '',
  }));
  const latest = store.listRevisions().slice(-1)[0];
  const baseId = input.baseRevisionId ?? input.expectedPreviousRevisionId ?? null;
  if (latest && latest.id !== baseId) {
    const latestAnchors = JSON.parse(latest.anchors_json) as AnchorSnapshot[];
    return {
      status: 409,
      error: 'REVISION_CONFLICT',
      message: `修订已过期：你基于 #${baseId} 提交，但当前最新修订是 #${latest.id}。`,
      requested_base_revision_id: baseId,
      latest_revision_id: latest.id,
      anchor_diff: diffAnchors(anchors, latestAnchors),
    };
  }

  const signature = anchorSignature(anchors);
  const now = Date.now();
  const res = store.prepare(
    'INSERT INTO revision (label, algo_version, anchors_json, anchors_signature, base_revision_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.label, ALGO_VERSION, JSON.stringify(anchors), signature, baseId, now);
  const revisionId = Number(res.lastInsertRowid);

  const sources = store.listSources().map((s) => ({ id: s.id, name: s.name }));
  const timeline = buildTimeline(store.listEventsWithReceipts(), sources, anchors);
  const insertOrder = store.prepare(
    'INSERT INTO revision_event (revision_id, event_id, corr_ms, half_width_ms, lo_ms, hi_ms, tie_group, tie_size, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  timeline.forEach((item, idx) => {
    insertOrder.run(
      revisionId,
      item.event_id,
      item.corr_ms,
      item.half_width_ms,
      item.lo_ms,
      item.hi_ms,
      item.tie_group,
      item.tie_size,
      idx,
    );
  });
  return { status: 201, revision: { id: revisionId, label: input.label, created_at_ms: now } };
}

export function replayRevisionTimeline(store: Store, revisionId: number) {
  const rev = store.getRevision(revisionId);
  if (!rev) return undefined;
  const sources = store.listSources().map((s) => ({ id: s.id, name: s.name }));
  const live = buildTimeline(store.listEventsWithReceipts(), sources, rev.anchors);
  const liveById = new Map(live.map((i) => [i.event_id, i]));
  const stored = store
    .prepare('SELECT * FROM revision_event WHERE revision_id = ? ORDER BY seq')
    .all(revisionId);
  const storedOrder = stored.map((r: any) => ({
    event_id: r.event_id,
    corr_ms: r.corr_ms,
    half_width_ms: r.half_width_ms,
    lo_ms: r.lo_ms,
    hi_ms: r.hi_ms,
    tie_group: r.tie_group,
    tie_size: r.tie_size,
    seq: r.seq,
    live: liveById.get(r.event_id) ?? null,
  }));
  return { revision: rev, storedOrder, liveOrder: live };
}
