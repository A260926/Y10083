import { describe, it, expect } from 'vitest';
import { seededDB, close } from './helpers.js';
import { buildTimeline, getRevision, listRevisions } from '../src/server/query.js';
import { createRevision } from '../src/server/revisions';
import type { AnchorInput } from '../src/shared/types.js';

describe('修订不可变与版本冲突', () => {
  it('旧修订保持不变且可重放出原排序，改锚点只生成新修订', async () => {
    const db = await seededDB();
    const before = buildTimeline(db, getRevision(db, 'rev-1')).map((r) => [r.eventKey, r.rank, r.correctedDisplay] as const);
    const anchors = getRevision(db, 'rev-2')!.anchors;
    const extra: AnchorInput = { anchorId: 'anc-new', source: 'svc-order', observedAt: '00:20', referenceAt: '2026-03-13T16:21:00Z', note: '新锚点' };
    const created = await createRevision(db, { basedOn: 'rev-2', anchors: [...anchors, extra], note: '第三修订' });
    expect(created.status).toBe(201);
    if (created.status === 201) expect(created.revision.revisionId).toBe('rev-3');

    const after = buildTimeline(db, getRevision(db, 'rev-1')).map((r) => [r.eventKey, r.rank, r.correctedDisplay] as const);
    expect(after).toEqual(before);
    expect(listRevisions(db).map((r) => r.revisionId)).toEqual(['rev-1', 'rev-2', 'rev-3']);

    const rev1 = getRevision(db, 'rev-1')!;
    expect(rev1.anchors.map((a) => a.anchorId)).not.toContain('anc-new');
    close(db);
  });

  it('两个用户基于同一旧修订提交时，后到者收到 409 与双方锚点差异', async () => {
    const db = await seededDB();
    const base = getRevision(db, 'rev-2')!.anchors;

    const userA = await createRevision(db, {
      basedOn: 'rev-2',
      note: '用户 A：新增早期 pay 锚点',
      anchors: [...base, { anchorId: 'anc-a', source: 'svc-pay', observedAt: '2026-03-13T15:20:00Z', referenceAt: '2026-03-13T15:20:10Z' }]
    });
    expect(userA.status).toBe(201);

    const userB = await createRevision(db, {
      basedOn: 'rev-2',
      note: '用户 B：删除一个锚点并修改另一个',
      anchors: [
        ...base
          .filter((a) => a.anchorId !== 'anc-p1')
          .map((a) =>
            a.anchorId === 'anc-o1'
              ? { anchorId: 'anc-o1', source: 'svc-order', observedAt: '23:00', referenceAt: '2026-03-13T15:00:45Z', note: '改成慢 45s' }
              : a
          ),
        { anchorId: 'anc-b', source: 'svc-ops', observedAt: '23:55', referenceAt: '2026-03-13T15:56:00Z' }
      ]
    });
    expect(userB.status).toBe(409);
    if (userB.status === 409) {
      expect(userB.error).toBe('revision_conflict');
      expect(userB.head.revisionId).toBe('rev-3');
      const diff = userB.anchorDiff;
      expect(diff.onlyInBase.map((a) => a.anchorId)).toEqual(['anc-a', 'anc-p1']);
      expect(diff.onlyInSubmitted.map((a) => a.anchorId)).toEqual(['anc-b']);
      expect(diff.changed.map((c) => c.anchorId)).toEqual(['anc-o1']);
      expect(diff.changed.find((c) => c.anchorId === 'anc-o1')!.base.referenceAt).toBe('2026-03-13T15:00:30.000Z');
      expect(diff.changed.find((c) => c.anchorId === 'anc-o1')!.submitted.referenceAt).toBe('2026-03-13T15:00:45.000Z');
    }
    close(db);
  });
});
