import { describe, expect, it } from 'vitest';
import { correctTimestamp, anchorSignature } from '../src/server/clock.js';
import { buildTimeline, orderItems } from '../src/server/timeline.js';
import type { AnchorSnapshot, EventWithReceipts } from '../src/server/types.js';

function anchorsFor(ms: number, trueMs: number, source = 'g', note = ''): AnchorSnapshot {
  return { source_id: source, observed_at_ms: ms, true_at_ms: trueMs, note };
}

describe('分段时钟偏移 v1', () => {
  it('单锚点：常数偏移，半宽为 epsilon', () => {
    const a = anchorsFor(10_000, 6_000);
    const est = correctTimestamp('g', 20_000, [a]);
    expect(est.corr_ms).toBe(16_000);
    expect(est.half_width_ms).toBe(500);
    expect(est.basis).toContain('单锚点');
  });

  it('双锚点之间线性插值（时钟跳变段）', () => {
    const a1 = anchorsFor(0, 0);
    const a2 = anchorsFor(10_000, 6_000); // 该段斜率 0.6
    const est = correctTimestamp('g', 5_000, [a1, a2]);
    expect(est.corr_ms).toBe(3_000);
    expect(est.basis).toContain('段内插值');
  });

  it('锚点之外使用外推段并增加外推距离到半宽', () => {
    const before = correctTimestamp('g', -4_000, [anchorsFor(0, 1_000), anchorsFor(10_000, 5_000)]);
    expect(before.corr_ms).toBe(-3_000);
    expect(before.half_width_ms).toBe(4_500);
    expect(before.basis).toContain('外推');
    const after = correctTimestamp('g', 12_000, [anchorsFor(0, 1_000), anchorsFor(10_000, 5_000)]);
    expect(after.corr_ms).toBe(7_000);
    expect(after.half_width_ms).toBe(2_500);
  });

  it('跨午夜偏移仍可校正（负偏移把次日时间拉回前一天）', () => {
    const obs = Date.parse('2026-09-29T00:00:20.123Z');
    const anchorObs = Date.parse('2026-09-28T23:59:30.000Z');
    const anchorTrue = Date.parse('2026-09-28T23:58:50.000Z');
    const est = correctTimestamp('pay', obs, [anchorsFor(anchorObs, anchorTrue, 'pay')]);
    expect(est.corr_ms).toBe(Date.parse('2026-09-28T23:59:40.123Z'));
  });

  it('锚点集合签名随集合内容变化而变', () => {
    const s1 = anchorSignature([anchorsFor(0, 0, 'a')]);
    const s2 = anchorSignature([anchorsFor(0, 1, 'a')]);
    expect(s1).not.toBe(s2);
  });
});

function makeEvent(id: string, lo: number, hi: number): EventWithReceipts {
  return {
    id,
    content_canonical: '{}',
    content_sha: 'x',
    summary: id,
    first_receipt_id: 0,
    conflict: 0,
    receipts: [],
  } as unknown as EventWithReceipts;
}

describe('稳定排序与区间并列', () => {
  it('区间重叠形成并列组，传递重叠归入同组，组内不暗示先后', () => {
    const items = [
      { event_id: 'a', summary: 'a', conflict: false, corr_ms: 0, half_width_ms: 10, lo_ms: -10, hi_ms: 10, unanchored: false, raw_min_ms: null, raw_max_ms: null, receipts: [], tie_group: null, tie_size: 1 },
      { event_id: 'b', summary: 'b', conflict: false, corr_ms: 0, half_width_ms: 10, lo_ms: 5, hi_ms: 25, unanchored: false, raw_min_ms: null, raw_max_ms: null, receipts: [], tie_group: null, tie_size: 1 },
      { event_id: 'c', summary: 'c', conflict: false, corr_ms: 0, half_width_ms: 10, lo_ms: 20, hi_ms: 40, unanchored: false, raw_min_ms: null, raw_max_ms: null, receipts: [], tie_group: null, tie_size: 1 },
      { event_id: 'd', summary: 'd', conflict: false, corr_ms: 0, half_width_ms: 10, lo_ms: 100, hi_ms: 120, unanchored: false, raw_min_ms: null, raw_max_ms: null, receipts: [], tie_group: null, tie_size: 1 },
    ];
    const ordered = orderItems(items);
    expect(ordered.map((i) => i.event_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(ordered.slice(0, 3).every((i) => i.tie_group === 1 && i.tie_size === 3)).toBe(true);
    expect(ordered[3].tie_group).toBeNull();
  });

  it('同下界以 event_id 稳定排序', () => {
    const mk = (id: string) => ({
      event_id: id, summary: id, conflict: false, corr_ms: 0, half_width_ms: 10,
      lo_ms: 0, hi_ms: 10, unanchored: false, raw_min_ms: null, raw_max_ms: null,
      receipts: [], tie_group: null, tie_size: 1,
    });
    const ordered = orderItems([mk('z'), mk('a'), mk('m')]);
    expect(ordered.map((i) => i.event_id)).toEqual(['a', 'm', 'z']);
  });

  it('未校时事件排在最后，按原始观测时间排序', () => {
    const anchored = {
      event_id: 'anc', summary: '', conflict: false, corr_ms: 50, half_width_ms: 0,
      lo_ms: 50, hi_ms: 50, unanchored: false, raw_min_ms: null, raw_max_ms: null,
      receipts: [], tie_group: null, tie_size: 1,
    };
    const u2 = {
      event_id: 'u2', summary: '', conflict: false, corr_ms: null, half_width_ms: null,
      lo_ms: null, hi_ms: null, unanchored: true, raw_min_ms: 10, raw_max_ms: 10,
      receipts: [], tie_group: null, tie_size: 1,
    };
    const u1 = {
      event_id: 'u1', summary: '', conflict: false, corr_ms: null, half_width_ms: null,
      lo_ms: null, hi_ms: null, unanchored: true, raw_min_ms: 0, raw_max_ms: 0,
      receipts: [], tie_group: null, tie_size: 1,
    };
    const ordered = orderItems([u2, anchored, u1]);
    expect(ordered.map((i) => i.event_id)).toEqual(['anc', 'u1', 'u2']);
  });

  it('buildTimeline 合并多来源区间', () => {
    const events: EventWithReceipts[] = [
      {
        id: 'e', content_canonical: '{}', content_sha: 'x', summary: 'e', first_receipt_id: 1, conflict: 0,
        receipts: [
          { id: 1, event_id: 'e', source_id: 'a', raw_text: '{}', raw_sha: 'h', observed_at_ms: 1000, received_at_ms: 0, batch_id: null, line_no: null },
          { id: 2, event_id: 'e', source_id: 'b', raw_text: '{}', raw_sha: 'h2', observed_at_ms: 2000, received_at_ms: 0, batch_id: null, line_no: null },
        ],
      },
    ];
    const tl = buildTimeline(
      events,
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      [anchorsFor(1000, 10_000, 'a'), anchorsFor(2000, 20_000, 'b')],
    );
    expect(tl[0].corr_ms).toBe(15_000);
    expect(tl[0].lo_ms).toBe(9_500);
    expect(tl[0].hi_ms).toBe(20_500);
    expect(tl[0].receipts.map((r) => r.source_id)).toEqual(['a', 'b']);
  });
});
