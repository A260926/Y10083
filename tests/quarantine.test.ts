import { describe, it, expect } from 'vitest';
import { freshDB, close } from './helpers.js';
import { importBatch } from '../src/server/store.js';
import { listEvents, listQuarantine } from '../src/server/query.js';

describe('坏行隔离', () => {
  it('批次中的坏行进入隔离区，不影响其他合法事件', async () => {
    const db = freshDB();
    const ndjson = [
      '{"id":"A-1","type":"log","observedAt":"10:00","detail":{"ok":true}}',
      '{"id":"A-2","observedAt":"oops-time","detail":{}}',
      '{not json',
      '{"observedAt":"10:02","detail":{}}',
      '{"id":"A-3","type":"log","observedAt":"2026-03-13T10:03:00Z","detail":{}}'
    ].join('\n');

    const report = await importBatch(db, 'svc-a', ndjson, '2026-03-13T11:00:00Z');
    expect(report.accepted.map((r) => r.eventKey)).toEqual(['evt_A-1', 'evt_A-3']);
    expect(report.rejected).toHaveLength(3);
    expect(report.rejected.map((r) => r.lineIndex)).toEqual([2, 3, 4]);

    const events = listEvents(db);
    expect(events.map((e) => e.eventKey).sort()).toEqual(['evt_A-1', 'evt_A-3']);

    const quarantined = listQuarantine(db);
    expect(quarantined).toHaveLength(3);
    expect(quarantined[0].rawLine).toContain('A-2');
    expect(quarantined[0].reason).toMatch(/observedAt|时间/);
    expect(quarantined[2].rawLine).toBe('{"observedAt":"10:02","detail":{}}');
    expect(quarantined[2].reason).toMatch(/id/);

    const archived = db.prepare('SELECT COUNT(*) AS c FROM raw_archive').get() as { c: number };
    expect(archived.c).toBe(5);
    close(db);
  });

  it('再次导入同样的坏行不会产生重复隔离记录', async () => {
    const db = freshDB();
    const bad = '{broken';
    await importBatch(db, 'svc-a', bad, '2026-03-13T11:00:00Z');
    await importBatch(db, 'svc-a', bad, '2026-03-13T11:05:00Z');
    expect(listQuarantine(db)).toHaveLength(1);
    close(db);
  });
});
