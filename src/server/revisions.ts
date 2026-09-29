import type { DatabaseSync } from 'node:sqlite';
import type { AnchorDiff, AnchorInput, AnchorView, Revision, TimeAnchor } from '../shared/types.js';
import { ALGO_VERSION } from '../shared/types.js';
import { canonicalJson, sha256Hex } from '../shared/digest.js';
import { anchorViewFrom, parseObserved, parseReferenceAt } from '../shared/time.js';
import { getHeadRevisionId, getRevision, listRevisions } from './query.js';

function normalizeAnchors(inputs: AnchorInput[]): TimeAnchor[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('至少需要一个时间锚点');
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    if (!input.source || typeof input.source !== 'string') throw new Error('锚点缺少 source');
    parseObserved(input.observedAt);
    parseReferenceAt(input.referenceAt);
    const anchorId = input.anchorId?.trim() || `anc_${index + 1}`;
    if (seen.has(anchorId)) throw new Error(`锚点 ID 重复: ${anchorId}`);
    seen.add(anchorId);
    return {
      anchorId,
      source: input.source,
      observedAt: input.observedAt,
      referenceAt: new Date(parseReferenceAt(input.referenceAt)).toISOString(),
      note: input.note ?? ''
    };
  });
}

export async function anchorDigestFor(inputs: AnchorInput[]): Promise<string> {
  const views = normalizeAnchors(inputs).map(anchorViewFrom);
  views.sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0));
  return sha256Hex(canonicalJson(views));
}

export interface CreateRevisionInput {
  basedOn: string | null;
  anchors: AnchorInput[];
  note?: string;
}

export interface CreateRevisionConflict {
  status: 409;
  error: 'revision_conflict';
  message: string;
  head: Revision;
  anchorDiff: AnchorDiff;
}

export type CreateRevisionResult = { status: 201; revision: Revision } | CreateRevisionConflict;

export async function createRevision(db: DatabaseSync, input: CreateRevisionInput): Promise<CreateRevisionResult> {
  const anchors = normalizeAnchors(input.anchors);
  const views = anchors.map(anchorViewFrom);
  const digest = await sha256Hex(canonicalJson([...views].sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0))));

  const existing = listRevisions(db).find((r) => r.anchorDigest === digest);
  if (existing) {
    return { status: 201, revision: existing };
  }

  const headId = getHeadRevisionId(db);
  const base = input.basedOn === null ? null : getRevision(db, input.basedOn);
  if (input.basedOn !== null && !base) throw new Error(`基准修订不存在: ${input.basedOn}`);
  if (input.basedOn === null && headId !== null) {
    throw new Error('已存在修订，创建新修订必须显式指定 basedOn');
  }
  if (headId !== null && base && base.revisionId !== headId) {
    const head = getRevision(db, headId)!;
    return {
      status: 409,
      error: 'revision_conflict',
      message: '修订已过期：你基于旧修订调整锚点，期间对方已发布新修订',
      head,
      anchorDiff: diffAnchors(head.anchors, views)
    };
  }

  const count = (db.prepare('SELECT COUNT(*) AS c FROM revisions').get() as { c: number }).c + 1;
  const createdAt = new Date().toISOString();
  const revisionId = `rev-${count}`;
  const revision: Revision = {
    revisionId,
    parentId: base?.revisionId ?? null,
    basedOn: base?.revisionId ?? null,
    anchorDigest: digest,
    anchors: views,
    algoVersion: ALGO_VERSION,
    createdAt,
    note: input.note ?? ''
  };
  db.prepare(
    `INSERT INTO revisions (revision_id, parent_id, based_on, anchor_digest, anchors_json, algo_version, created_at, note)
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
  return { status: 201, revision };
}

export function diffAnchors(base: AnchorView[], submitted: AnchorView[]): AnchorDiff {
  const baseMap = new Map(base.map((a) => [a.anchorId, a]));
  const submittedMap = new Map(submitted.map((a) => [a.anchorId, a]));
  const onlyInBase: AnchorView[] = [];
  const onlyInSubmitted: AnchorView[] = [];
  const changed: AnchorDiff['changed'] = [];
  for (const anchor of base) {
    const other = submittedMap.get(anchor.anchorId);
    if (!other) onlyInBase.push(anchor);
    else if (canonicalJson(anchor) !== canonicalJson(other)) changed.push({ anchorId: anchor.anchorId, base: anchor, submitted: other });
  }
  for (const anchor of submitted) {
    if (!baseMap.has(anchor.anchorId)) onlyInSubmitted.push(anchor);
  }
  const sortFn = (a: AnchorView, b: AnchorView) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0);
  return { onlyInBase: onlyInBase.sort(sortFn), onlyInSubmitted: onlyInSubmitted.sort(sortFn), changed };
}
