import type { DatabaseSync } from 'node:sqlite';
import type {
  AnchorView,
  EventRecord,
  QuarantineItem,
  Receipt,
  Revision,
  TimelineRow
} from '../shared/types.js';
import { buildSourceModel, correctObserved, overlap, parseObserved } from '../shared/time.js';
import type { TimeAnchor } from '../shared/types.js';

interface EventRow {
  event_key: string;
  id: string;
  canonical_json: string;
  content_digest: string;
  primary_source: string;
  conflict: number;
}

function receiptsFor(db: DatabaseSync, eventKey: string): Receipt[] {
  return (
    db
      .prepare(
        'SELECT source, received_at, raw_digest, line_index FROM receipts WHERE event_key = ? ORDER BY source, received_at, raw_digest'
      )
      .all(eventKey) as { source: string; received_at: string; raw_digest: string; line_index: number | null }[]
  ).map((r) => ({ source: r.source, receivedAt: r.received_at, rawDigest: r.raw_digest, lineIndex: r.line_index }));
}

export function listEvents(db: DatabaseSync): EventRecord[] {
  const rows = db
    .prepare('SELECT event_key, id, canonical_json, content_digest, primary_source, conflict FROM events ORDER BY event_key')
    .all() as unknown as EventRow[];
  return rows.map((row) => ({
    eventKey: row.event_key,
    canonical: JSON.parse(row.canonical_json),
    contentDigest: row.content_digest,
    primarySource: row.primary_source,
    receipts: receiptsFor(db, row.event_key),
    conflict: row.conflict === 1
  }));
}

function revisionFromRow(row: {
  revision_id: string;
  parent_id: string | null;
  based_on: string | null;
  anchor_digest: string;
  anchors_json: string;
  algo_version: string;
  created_at: string;
  note: string;
}): Revision {
  return {
    revisionId: row.revision_id,
    parentId: row.parent_id,
    basedOn: row.based_on,
    anchorDigest: row.anchor_digest,
    anchors: JSON.parse(row.anchors_json) as AnchorView[],
    algoVersion: row.algo_version,
    createdAt: row.created_at,
    note: row.note
  };
}

export function listRevisions(db: DatabaseSync): Revision[] {
  const rows = db.prepare('SELECT * FROM revisions ORDER BY created_at, revision_id').all() as Parameters<
    typeof revisionFromRow
  >[0][];
  return rows.map(revisionFromRow);
}

export function getRevision(db: DatabaseSync, revisionId: string): Revision | null {
  const row = db.prepare('SELECT * FROM revisions WHERE revision_id = ?').get(revisionId) as
    | Parameters<typeof revisionFromRow>[0]
    | undefined;
  return row ? revisionFromRow(row) : null;
}

export function getHeadRevisionId(db: DatabaseSync): string | null {
  const row = db
    .prepare('SELECT revision_id FROM revisions ORDER BY created_at DESC, revision_id DESC LIMIT 1')
    .get() as { revision_id: string } | undefined;
  return row?.revision_id ?? null;
}

export interface TimelineEntry extends TimelineRow {
  rank: number;
  tieGroup: number;
  tieKeys: string[];
  correctedDisplay: string | null;
  intervalDisplay: string | null;
}

export function buildTimeline(db: DatabaseSync, revision: Revision | null): TimelineEntry[] {
  const anchorsBySource = new Map<string, ReturnType<typeof buildSourceModel>>();
  if (revision) {
    const grouped = new Map<string, TimeAnchor[]>();
    for (const anchor of revision.anchors) {
      const list = grouped.get(anchor.source) ?? [];
      list.push({
        anchorId: anchor.anchorId,
        source: anchor.source,
        observedAt: anchor.observedAt,
        referenceAt: anchor.referenceAt,
        note: anchor.note
      });
      grouped.set(anchor.source, list);
    }
    for (const [source, list] of grouped) anchorsBySource.set(source, buildSourceModel(list));
  }

  const events = listEvents(db);
  const rows: TimelineRow[] = events.map((event) => {
    const canonical = event.canonical;
    const parsed = parseObserved(canonical.observedAt);
    const correction = correctObserved(canonical.observedAt, event.primarySource, anchorsBySource);
    return {
      eventKey: event.eventKey,
      eventId: canonical.id,
      type: canonical.type,
      primarySource: event.primarySource,
      sources: event.receipts.map((r) => r.source),
      conflict: event.conflict,
      observed: {
        raw: canonical.observedAt,
        kind: parsed.kind,
        unwrappedMs: parsed.ms,
        display: parsed.display
      },
      correction: correction
        ? {
            source: correction.source,
            correctedMs: correction.correctedMs,
            lowerMs: correction.correctedMs - correction.halfWidthMs,
            upperMs: correction.correctedMs + correction.halfWidthMs,
            halfWidthMs: correction.halfWidthMs,
            extrapolated: correction.extrapolated,
            basisAnchorIds: correction.basisAnchorIds,
            algoVersion: correction.algoVersion
          }
        : null,
      detail: canonical.detail,
      contentDigest: event.contentDigest
    };
  });

  rows.sort((a, b) => {
    const ac = a.correction;
    const bc = b.correction;
    if (ac && bc) {
      if (ac.lowerMs !== bc.lowerMs) return ac.lowerMs - bc.lowerMs;
      if (ac.upperMs !== bc.upperMs) return ac.upperMs - bc.upperMs;
      if (ac.correctedMs !== bc.correctedMs) return ac.correctedMs - bc.correctedMs;
    } else if (ac || bc) {
      return ac ? -1 : 1;
    }
    if (a.observed.unwrappedMs !== b.observed.unwrappedMs) return a.observed.unwrappedMs - b.observed.unwrappedMs;
    if (a.primarySource !== b.primarySource) return a.primarySource < b.primarySource ? -1 : 1;
    return a.eventKey < b.eventKey ? -1 : a.eventKey > b.eventKey ? 1 : 0;
  });

  // 稳定并列规则：仅当不确定区间互不重叠时才承认先后；重叠者归入同一 tie 组。
  const tieGroups: number[] = new Array(rows.length).fill(-1);
  let group = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].correction) break;
    if (tieGroups[i] !== -1) continue;
    const members = [i];
    tieGroups[i] = group;
    for (let j = i + 1; j < rows.length; j++) {
      if (!rows[j].correction) break;
      const overlapsAnyMember = members.some((m) =>
        overlap(
          { lowerMs: rows[m].correction!.lowerMs, upperMs: rows[m].correction!.upperMs },
          { lowerMs: rows[j].correction!.lowerMs, upperMs: rows[j].correction!.upperMs }
        )
      );
      if (!overlapsAnyMember) break;
      members.push(j);
      tieGroups[j] = group;
    }
    group += 1;
  }

  const groupKeys = new Map<number, string[]>();
  rows.forEach((row, idx) => {
    if (tieGroups[idx] === -1) return;
    const list = groupKeys.get(tieGroups[idx]) ?? [];
    list.push(row.eventKey);
    groupKeys.set(tieGroups[idx], list);
  });
  for (const [g, keys] of groupKeys) {
    if (keys.length === 1) {
      const idx = tieGroups.indexOf(g);
      tieGroups[idx] = -1;
      groupKeys.delete(g);
    }
  }

  return rows.map((row, idx) => ({
    ...row,
    rank: idx + 1,
    tieGroup: tieGroups[idx],
    tieKeys: tieGroups[idx] === -1 ? [] : groupKeys.get(tieGroups[idx])!,
    correctedDisplay: row.correction ? new Date(row.correction.correctedMs).toISOString() : null,
    intervalDisplay: row.correction
      ? `±${(row.correction.halfWidthMs / 1000).toFixed(3)}s`
      : null
  }));
}

export function listQuarantine(db: DatabaseSync): QuarantineItem[] {
  return (
    db
      .prepare('SELECT quarantine_id, source, received_at, raw_text, reason, line_index FROM quarantine ORDER BY source, line_index, quarantine_id')
      .all() as {
      quarantine_id: string;
      source: string;
      received_at: string;
      raw_text: string;
      reason: string;
      line_index: number | null;
    }[]
  ).map((r) => ({
    quarantineId: r.quarantine_id,
    source: r.source,
    receivedAt: r.received_at,
    rawLine: r.raw_text,
    reason: r.reason,
    lineIndex: r.line_index
  }));
}
