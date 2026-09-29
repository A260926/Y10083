import { describe, it, expect } from 'vitest';
import { seededDB, close } from './helpers.js';
import { buildTimeline, getRevision } from '../src/server/query.js';
import type { DatabaseSync } from 'node:sqlite';
import { correctObserved, buildSourceModel, type OrderedAnchor } from '../src/shared/time.js';
import type { TimeAnchor } from '../src/shared/types.js';

function correct(db: DatabaseSync, revisionId: string, source: string, observed: string) {
  const revision = getRevision(db, revisionId)!;
  const grouped = new Map<string, TimeAnchor[]>();
  for (const a of revision.anchors) {
    const list = grouped.get(a.source) ?? [];
    list.push({ anchorId: a.anchorId, source: a.source, observedAt: a.observedAt, referenceAt: a.referenceAt, note: a.note });
    grouped.set(a.source, list);
  }
  const models = new Map<string, OrderedAnchor[]>();
  for (const [s, list] of grouped) models.set(s, buildSourceModel(list));
  return correctObserved(observed, source, models)!;
}

describe('分段时钟偏移校正', () => {
  it('跨午夜的墙钟被展开到正确日期，且分段边界前后使用不同偏移', async () => {
    const db = await seededDB();

    const rev2 = getRevision(db, 'rev-2')!;
    expect(rev2.algoVersion).toBe('piecewise-offset-v1');

    const before = correct(db, 'rev-2', 'svc-order', '23:05');
    const after = correct(db, 'rev-2', 'svc-order', '00:02:10');

    expect(new Date(before.correctedMs).toISOString()).toBe('2026-03-13T15:05:22.500Z');
    expect(new Date(after.correctedMs).toISOString()).toBe('2026-03-13T16:01:10.000Z');

    expect(before.basisAnchorIds).toEqual(['anc-o1', 'anc-o2']);
    expect(after.basisAnchorIds).toEqual(['anc-o2', 'anc-o3']);
    // 段内偏移 30s/-60s → 漂移 120s 的一半 60s + 1s 基础容差
    expect(before.halfWidthMs).toBe(46000);
    expect(after.halfWidthMs).toBe(1000);

    const timeline = buildTimeline(db, rev2);
    const row8 = timeline.find((r) => r.eventId === 'INC-8')!;
    const row4 = timeline.find((r) => r.eventId === 'INC-4')!;
    expect(row8.rank).toBeLessThan(row4.rank);
    expect(row8.correction!.lowerMs).toBeLessThan(row4.correction!.lowerMs);

    close(db);
  });

  it('rev-1 未分段：INC-3 与 INC-4 区间重叠（不可判定先后）；rev-2 分段后 INC-8 早于 INC-4', async () => {
    const db = await seededDB();
    const rev1 = buildTimeline(db, getRevision(db, 'rev-1'));
    const r3 = rev1.find((r) => r.eventId === 'INC-8')!;
    const r4 = rev1.find((r) => r.eventId === 'INC-4')!;
    const lo = Math.max(r3.correction!.lowerMs, r4.correction!.lowerMs);
    const hi = Math.min(r3.correction!.upperMs, r4.correction!.upperMs);
    expect(lo <= hi).toBe(true);
    expect(r3.tieKeys).toContain('evt_INC-4');
    expect(r4.tieKeys).toContain('evt_INC-3');

    const rev2 = buildTimeline(db, getRevision(db, 'rev-2'));
    const row8 = rev2.find((r) => r.eventId === 'INC-8')!;
    const row4 = rev2.find((r) => r.eventId === 'INC-4')!;
    // 分段后 INC-8 不再与 INC-4 同组并列（rev-1 的并列组被解开）
    expect(row8.tieKeys).not.toContain('evt_INC-4');
    expect(row4.tieKeys).not.toContain('evt_INC-8');
    expect(row8.rank).toBeLessThan(row4.rank);
    close(db);
  });

  it('rev-2 中冲突事件 INC-3 同时带两个来源，pay 侧校时正常', async () => {
    const db = await seededDB();
    const timeline = buildTimeline(db, getRevision(db, 'rev-2'));
    const row3 = timeline.find((r) => r.eventId === 'INC-3')!;
    expect(row3.conflict).toBe(true);
    expect(row3.sources.sort()).toEqual(['svc-order', 'svc-pay']);
    expect(row3.correction!.source).toBe('svc-order');
    close(db);
  });
});
