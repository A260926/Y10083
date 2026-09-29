import { describe, it, expect } from 'vitest';
import { freshDB, close } from './helpers.js';
import { importOne } from '../src/server/store.js';
import { listEvents } from '../src/server/query.js';

const event = (amount: number) =>
  JSON.stringify({ id: 'DUP-1', type: 'log', observedAt: '10:00', detail: { amount } });

describe('重复收据合并', () => {
  it('相同事件重复导入合并为来源收据，不同来源各自保留', async () => {
    const db = freshDB();
    const r1 = await importOne(db, 'svc-a', event(1), '2026-03-13T11:00:00Z', 1);
    const r2 = await importOne(db, 'svc-a', event(1), '2026-03-13T11:01:00Z', 2);
    const r3 = await importOne(db, 'svc-b', event(1), '2026-03-13T11:02:00Z', null);
    expect(r1.ok).toBe(true);
    expect(r2.mergedReceipt).toBe(true);
    expect(r3.mergedReceipt).toBe(false);

    const events = listEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].receipts).toHaveLength(2);
    expect(events[0].receipts.map((r) => r.source).sort()).toEqual(['svc-a', 'svc-b']);
    expect(events[0].receipts.map((r) => r.receivedAt))
      .toContain('2026-03-13T11:01:00Z');

    const rawCount = db.prepare('SELECT COUNT(*) AS c FROM raw_archive').get() as { c: number };
    expect(rawCount.c).toBe(1);
    close(db);
  });

  it('相同 ID 但内容不同必须标记冲突，且仍保留两条来源收据', async () => {
    const db = freshDB();
    await importOne(db, 'svc-a', event(1), '2026-03-13T11:00:00Z', null);
    const conflict = await importOne(db, 'svc-b', event(2), '2026-03-13T11:02:00Z', null);
    expect(conflict.conflict).toBe(true);

    const events = listEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].conflict).toBe(true);
    expect(events[0].receipts.map((r) => r.source).sort()).toEqual(['svc-a', 'svc-b']);

    const variants = db.prepare('SELECT COUNT(*) AS c FROM event_variants').get() as { c: number };
    expect(variants.c).toBe(2);
    close(db);
  });
});
