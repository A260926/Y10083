import { describe, expect, it } from 'vitest';
import { tempStore } from './helpers.js';

describe('坏行隔离：批次内坏行不丢弃合法事件', () => {
  it('合法行入库、坏行进隔离区并保留原始字节', async () => {
    const store = await tempStore();
    const ndjson = [
      '{"event_id":"ok1","source":"svc-a","observed_at":"2026-01-01T00:00:00Z","content":{"message":"好行1"}}',
      '这不是JSON',
      '{"source":"svc-a","content":{"message":"没有event_id"}}',
      '{"event_id":"ok2","source":"svc-a","observed_at":"not-a-time","content":{"message":"坏时间"}}',
      '{"event_id":"ok3","source":"svc-b","observed_at":1767225600000,"content":{"message":"好行2"}}',
      '{"event_id":"ok4","source":"svc-c"}',
    ].join('\n');
    const result = store.importLines(ndjson);
    expect(result.accepted).toBe(3);
    expect(result.rejected).toBe(3);
    const q = store.listQuarantine();
    expect(q.map((r) => r.line_no)).toEqual([2, 3, 4]);
    expect(q[0].raw_text).toBe('这不是JSON');
    expect(q[0].raw_sha).toMatch(/^[a-f0-9]{64}$/);
    expect(q[2].reason).toContain('时间');
    const events = store.listEventsWithReceipts();
    expect(events.map((e) => e.id).sort()).toEqual(['ok1', 'ok3', 'ok4']);
  });

  it('再次导入同一批次：合法行成为重复收据合并，隔离行仍保留', async () => {
    const store = await tempStore();
    const line = '{"event_id":"dup","source":"svc-a","content":{"message":"x"}}';
    const first = store.importLines(line + '\n坏行');
    const second = store.importLines(line + '\n坏行');
    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.rejected).toBe(1);
    const receipts = store.listReceipts();
    expect(receipts.filter((r) => r.event_id === 'dup')).toHaveLength(1);
    expect(store.listQuarantine()).toHaveLength(2);
  });

  it('相同 event_id 不同内容：冲突标记，但收据都保留', async () => {
    const store = await tempStore();
    store.importLines('{"event_id":"c1","source":"s1","content":{"amount":100}}');
    const r = store.importLines('{"event_id":"c1","source":"s2","content":{"amount":200}}');
    expect(r.conflicts).toContain('c1');
    const ev = store.listEventsWithReceipts().find((e) => e.id === 'c1')!;
    expect(ev.conflict).toBe(1);
    expect(ev.receipts).toHaveLength(2);
    const s2 = ev.receipts.find((x) => x.source_id === 's2')!;
    expect(JSON.parse(s2.raw_text).content.amount).toBe(200);
  });

  it('多来源同内容：合并来源收据而不冲突', async () => {
    const store = await tempStore();
    store.importLines(
      '{"event_id":"m1","source":"s1","observed_at":"2026-01-01T00:00:00Z","content":{"v":1}}\n' +
        '{"event_id":"m1","source":"s2","observed_at":"2026-01-01T00:00:01Z","content":{"v":1}}',
    );
    const ev = store.listEventsWithReceipts().find((e) => e.id === 'm1')!;
    expect(ev.conflict).toBe(0);
    expect(ev.receipts.map((r) => r.source_id).sort()).toEqual(['s1', 's2']);
  });
});
