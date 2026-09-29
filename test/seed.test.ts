import { describe, expect, it } from 'vitest';
import { tempStore, storedOrder, roundtrip } from './helpers.js';
import { seedStore } from '../src/server/seed.js';
import { buildExport, computeManifestTotal } from '../src/server/export.js';
import { replayBundle } from '../src/server/replay.js';

describe('预置示例', () => {
  it('包含跨午夜、时钟跳变、冲突 ID、坏行与两个修订', async () => {
    const store = await tempStore();
    seedStore(store);
    const q = store.listQuarantine();
    expect(q).toHaveLength(2);
    const e2 = store.listEventsWithReceipts().find((e) => e.id === 'e2')!;
    expect(e2.conflict).toBe(1);
    expect(e2.receipts.map((r) => r.source_id).sort()).toEqual(['gateway', 'pay-api']);
    const revs = store.listRevisions();
    expect(revs).toHaveLength(2);
    const r1 = storedOrder(store, 1).map((o: any) => o.event_id);
    const r2 = storedOrder(store, 2).map((o: any) => o.event_id);
    const e2R1 = storedOrder(store, 1).find((o: any) => o.event_id === 'e2')!;
    const e2R2 = storedOrder(store, 2).find((o: any) => o.event_id === 'e2')!;
    expect(e2R1.corr_ms).not.toBe(e2R2.corr_ms);
    // 跨午夜：原始在次日，校正后回到前一日 23:xx，R1 中 e2 排在 gateway 事件之前
    expect(r1).not.toEqual(r2);
    expect(r1.indexOf('e2')).toBeLessThan(r1.indexOf('g1'));
    // g2、g3 始终并列（区间重叠），切换修订不产生虚假先后
    const g2 = storedOrder(store, 2).find((o: any) => o.event_id === 'g2')!;
    const g3 = storedOrder(store, 2).find((o: any) => o.event_id === 'g3')!;
    expect(g2.tie_group).not.toBeNull();
    expect(g2.tie_group).toBe(g3.tie_group);
    // 事件摘要不受修订影响
    const summary1 = store.listEventsWithReceipts().find((e) => e.id === 'e1')!.summary;
    expect(summary1).toContain('charge');
  });

  it('竞争假设可同时包含同一事件且不写回事件', async () => {
    const store = await tempStore();
    seedStore(store);
    const hs = store.listHypotheses();
    expect(hs).toHaveLength(2);
    const inBoth = hs.every((h) => h.event_ids.includes('e2'));
    expect(inBoth).toBe(true);
    const e2 = store.listEventsWithReceipts().find((e) => e.id === 'e2')!;
    expect(JSON.stringify(e2)).not.toContain('hypothesis');
  });
});

describe('导出与重放', () => {
  it('重放后排序、并列组、来源链与原始一致', async () => {
    const store = await tempStore();
    seedStore(store);
    const before1 = storedOrder(store, 1);
    const before2 = storedOrder(store, 2);
    const receiptsBefore = store.listReceipts().map((r) => [r.event_id, r.source_id, r.raw_sha]);
    const result = roundtrip(store);
    expect(result.verified.sort_signatures.every((s) => s.match)).toBe(true);
    expect(result.verified.source_chain.matched).toBe(result.verified.source_chain.receipt_count);
    expect(storedOrder(store, 1)).toEqual(before1);
    expect(storedOrder(store, 2)).toEqual(before2);
    const receiptsAfter = store.listReceipts().map((r) => [r.event_id, r.source_id, r.raw_sha]);
    expect(receiptsAfter).toEqual(receiptsBefore);
    expect(store.listQuarantine()).toHaveLength(2);
  });

  it('篡改 manifest 或排序段时重放被拒绝', async () => {
    const store = await tempStore();
    seedStore(store);
    const bundle = buildExport(store) as any;
    bundle.data.sources[0].name = 'attacker';
    expect(() => replayBundle(store, bundle)).toThrow(/manifest/);
    const bundle2 = buildExport(store) as any;
    bundle2.data.revisions[0].order.reverse();
    expect(() => replayBundle(store, bundle2)).toThrow(/manifest/);
    const bundle3 = buildExport(store) as any;
    bundle3.manifest.sort_signature['1'] = '00'.repeat(32);
    bundle3.manifest.total_manifest_sha256 = computeManifestTotal(bundle3.data, {
      generated_at_ms: bundle3.manifest.generated_at_ms,
      algorithm: bundle3.manifest.algorithm,
      hashes: bundle3.manifest.hashes,
      sort_signature: bundle3.manifest.sort_signature,
    });
    expect(() => replayBundle(store, bundle3)).toThrow(/排序签名/);
  });
});
