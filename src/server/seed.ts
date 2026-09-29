import type { Store } from './store.js';
import { createRevision } from './revisions.js';

const SAMPLE_NDJSON = `{"event_id":"e1","source":"pay-api","observed_at":"2026-09-28T23:59:10.000Z","received_at":"2026-09-28T15:59:30Z","content":{"type":"request","message":"POST /charge 开始"}}
{"event_id":"e2","source":"pay-api","observed_at":"2026-09-29T00:00:20.123Z","content":{"type":"request","message":"POST /refund 扣款 100"}}
{"event_id":"e2","source":"gateway","observed_at":"2026-09-28T15:59:38.123-08:00","content":{"type":"request","message":"POST /refund 扣款 200"}}
{"event_id":"g1","source":"gateway","observed_at":"2026-09-28T15:58:30.000-08:00","content":{"level":"WARN","message":"上游连接抖动"}}
{"event_id":"g2","source":"gateway","observed_at":"2026-09-28T16:01:48.421-08:00","content":{"level":"INFO","message":"NTP 校时完成，时钟回拨 40s"}}
{"event_id":"g3","source":"gateway","observed_at":"2026-09-28T16:01:48.910-08:00","content":{"level":"INFO","message":"重试队列开始排空"}}
{not valid json
{"event_id":"e3"}`;

export function seedIfNeeded(store: Store): boolean {
  const count = store.prepare('SELECT COUNT(*) AS c FROM source').get().c as number;
  if (count > 0) return false;
  seedStore(store);
  return true;
}

export function seedStore(store: Store): void {
  store.transaction(() => {
    const result = store.importLines(SAMPLE_NDJSON);
    if (result.rejected !== 2) {
      throw new Error(`种子数据隔离数量异常：期望 2，实际 ${result.rejected}`);
    }
    if (!result.conflicts.includes('e2')) {
      throw new Error('种子数据应包含 e2 内容冲突');
    }

    // 修订1：只有 pay-api 的跨午夜锚点
    store.addAnchor(
      'pay-api',
      Date.parse('2026-09-28T23:59:30.000Z'),
      Date.parse('2026-09-28T23:58:50.000Z'),
      'R1：人工比对部署标记（跨午夜）',
    );
    const r1 = createRevision(store, {
      label: '修订 R1：仅 pay-api 锚点（跨午夜）',
      anchors: [
        {
          source_id: 'pay-api',
          observed_at_ms: Date.parse('2026-09-28T23:59:30.000Z'),
          true_at_ms: Date.parse('2026-09-28T23:58:50.000Z'),
          note: '人工比对部署标记（跨午夜）',
        },
      ],
      baseRevisionId: null,
    });
    if (r1.status !== 201) throw new Error('种子修订 R1 创建失败');

    // 修订2：追加 gateway 双锚点，刻画 16:02 的 -40s 时钟跳变
    store.addAnchor(
      'gateway',
      Date.parse('2026-09-28T16:00:00.000-08:00'),
      Date.parse('2026-09-28T23:59:20.000Z'),
      'R2：gateway 跳变前段锚点',
    );
    store.addAnchor(
      'gateway',
      Date.parse('2026-09-28T16:02:30.000-08:00'),
      Date.parse('2026-09-29T00:01:50.000Z'),
      'R2：gateway NTP 回拨后锚点',
    );
    const r2 = createRevision(store, {
      label: '修订 R2：pay-api 跨午夜 + gateway 时钟跳变双锚点',
      anchors: [
        {
          source_id: 'pay-api',
          observed_at_ms: Date.parse('2026-09-28T23:59:30.000Z'),
          true_at_ms: Date.parse('2026-09-28T23:58:50.000Z'),
          note: '人工比对部署标记（跨午夜）',
        },
        {
          source_id: 'gateway',
          observed_at_ms: Date.parse('2026-09-28T16:00:00.000-08:00'),
          true_at_ms: Date.parse('2026-09-28T23:59:20.000Z'),
          note: 'gateway 跳变前段锚点',
        },
        {
          source_id: 'gateway',
          observed_at_ms: Date.parse('2026-09-28T16:02:30.000-08:00'),
          true_at_ms: Date.parse('2026-09-29T00:01:50.000Z'),
          note: 'gateway NTP 回拨后锚点',
        },
      ],
      baseRevisionId: 1,
    });
    if (r2.status !== 201) throw new Error('种子修订 R2 创建失败');

    store.addHypothesis(
      'H1：gateway 时钟跳变掩盖了退款顺序',
      '依据：g2 NTP 回拨日志 + e2 两来源收据在跳变前后各出现一次；置信说明：中等，跨午夜收据仍需第三方确认。',
      'medium',
      ['g1', 'g2', 'e2'],
    );
    store.addHypothesis(
      'H2：独立的支付双写竞争',
      '依据：e2 两个来源内容金额不一致（100 vs 200），且无共享 trace；置信说明：低，与 H1 竞争但不互斥，事件 e2 可同时属于两条链。',
      'low',
      ['e1', 'e2'],
    );
  });
}
