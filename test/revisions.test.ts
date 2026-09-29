import { describe, expect, it } from 'vitest';
import { tempStore, storedOrder } from './helpers.js';
import { createRevision } from '../src/server/revisions.js';

describe('修订不可变与并发保护', () => {
  it('旧修订重放结果固定：改锚点只产生新修订', async () => {
    const store = await tempStore();
    store.ensureSource('g');
    store.importLines(
      '{"event_id":"e1","source":"g","observed_at":10000,"content":{"m":1}}\n' +
        '{"event_id":"e2","source":"g","observed_at":20000,"content":{"m":2}}',
    );
    store.addAnchor('g', 10_000, 100_000, 'a1');
    const r1 = createRevision(store, {
      label: 'R1',
      anchors: [{ source_id: 'g', observed_at_ms: 10_000, true_at_ms: 100_000, note: 'a1' }],
      baseRevisionId: null,
    });
    expect(r1.status).toBe(201);
    const r1Order = storedOrder(store, 1);
    expect(r1Order.map((o: any) => o.corr_ms)).toEqual([100_000, 110_000]);

    store.addAnchor('g', 30_000, 200_000, 'a2');
    const r2 = createRevision(store, {
      label: 'R2',
      anchors: [
        { source_id: 'g', observed_at_ms: 10_000, true_at_ms: 100_000, note: 'a1' },
        { source_id: 'g', observed_at_ms: 30_000, true_at_ms: 200_000, note: 'a2' },
      ],
      baseRevisionId: 1,
    });
    expect(r2.status).toBe(201);

    const r2Order = storedOrder(store, 2);
    expect(r2Order.map((o: any) => o.corr_ms)).toEqual([100_000, 150_000]);
    const r1Again = storedOrder(store, 1);
    expect(r1Again).toEqual(r1Order);
  });

  it('旧修订锚定创建时事件集合：新事件不出现在旧修订', async () => {
    const store = await tempStore();
    store.ensureSource('g');
    store.importLines('{"event_id":"old","source":"g","observed_at":1000,"content":{"m":1}}');
    store.addAnchor('g', 1000, 5000);
    const r1 = createRevision(store, {
      label: 'R1',
      anchors: [{ source_id: 'g', observed_at_ms: 1000, true_at_ms: 5000 }],
      baseRevisionId: null,
    });
    expect(r1.status).toBe(201);
    store.importLines('{"event_id":"new","source":"g","observed_at":2000,"content":{"m":2}}');
    expect(storedOrder(store, 1).map((o: any) => o.event_id)).toEqual(['old']);
  });

  it('并发：基于过期修订提交返回 409 且携带双方锚点差异', async () => {
    const store = await tempStore();
    store.ensureSource('g');
    const r1 = createRevision(store, {
      label: 'R1',
      anchors: [{ source_id: 'g', observed_at_ms: 0, true_at_ms: 0 }],
      baseRevisionId: null,
    });
    expect(r1.status).toBe(201);
    createRevision(store, {
      label: 'R2-by-user-A',
      anchors: [{ source_id: 'g', observed_at_ms: 0, true_at_ms: 1000, note: 'A' }],
      baseRevisionId: 1,
    });
    const stale = createRevision(store, {
      label: 'R3-by-user-B',
      anchors: [{ source_id: 'g', observed_at_ms: 0, true_at_ms: 4000, note: 'B' }],
      baseRevisionId: 1,
    });
    expect(stale.status).toBe(409);
    if (stale.status !== 409) throw new Error('unreachable');
    expect(stale.latest_revision_id).toBe(2);
    expect(stale.anchor_diff[0].requested_true_at_ms).toBe(4000);
    expect(stale.anchor_diff[0].latest_true_at_ms).toBe(1000);
    expect(stale.anchor_diff[0].true_delta_ms).toBe(3000);
  });
});
