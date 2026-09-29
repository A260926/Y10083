import { describe, it, expect } from 'vitest';
import { freshDB, close } from './helpers.js';
import { importBatch } from '../src/server/store.js';
import { createRevision } from '../src/server/revisions';
import { buildTimeline, getRevision } from '../src/server/query.js';

describe('区间并列稳定排序', () => {
  it('区间重叠的事件标记为并列且顺序稳定，不重叠时承认先后', async () => {
    const db = freshDB();
    await importBatch(
      db,
      'svc-a',
      [
        '{"id":"T-A","observedAt":"10:00:00","detail":{"n":1}}',
        '{"id":"T-B","observedAt":"10:00:01","detail":{"n":2}}',
        '{"id":"T-C","observedAt":"10:00:40","detail":{"n":3}}'
      ].join('\n'),
      '2026-03-13T12:00:00Z'
    );
    await createRevision(db, {
      basedOn: null,
      note: '大不确定度锚点',
      anchors: [
        { anchorId: 'a1', source: 'svc-a', observedAt: '09:00', referenceAt: '2026-03-13T09:00:00Z', note: '' },
        { anchorId: 'a2', source: 'svc-a', observedAt: '11:00', referenceAt: '2026-03-13T11:00:00Z', note: '无漂移锚点 → 半宽约 1s' }
      ]
    });

    const rows = buildTimeline(db, getRevision(db, 'rev-1'));
    const a = rows.find((r) => r.eventId === 'T-A')!;
    const b = rows.find((r) => r.eventId === 'T-B')!;
    const c = rows.find((r) => r.eventId === 'T-C')!;

    // T-A 与 T-B 相差 1s，半宽 16s，区间重叠 → 并列同组
    expect(a.tieKeys).toContain('evt_T-B');
    expect(b.tieKeys).toContain('evt_T-A');
    expect(b.tieGroup).toBe(a.tieGroup);

    // T-C 距 T-A 40s，区间不重叠 → 独立组，明确在后
    expect(c.tieGroup).not.toBe(a.tieGroup);
    expect(c.tieKeys).toEqual([]);
    expect(c.rank).toBeGreaterThan(b.rank);

    // 稳定规则：并列内部顺序由 (下界, 上界, 校正点, eventKey) 决定，可重复
    const again = buildTimeline(db, getRevision(db, 'rev-1'));
    expect(again.map((r) => r.eventKey)).toEqual(rows.map((r) => r.eventKey));
    close(db);
  });
});
