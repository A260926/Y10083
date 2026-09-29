import { describe, it, expect } from 'vitest';
import { seededDB, freshDB, close } from './helpers.js';
import { buildBundle, replayBundle, ManifestError } from '../src/server/exportimport.js';
import { buildTimeline, getRevision, listEvents, listQuarantine } from '../src/server/query.js';
import { listHypotheses } from '../src/server/hypotheses.js';

function orderSignatures(db: ReturnType<typeof freshDB>) {
  return ['rev-1', 'rev-2'].map((id) => {
    const rows = buildTimeline(db, getRevision(db, id));
    return {
      id,
      order: rows.map((r) => r.eventKey),
      intervals: rows.map((r) => [r.correction?.lowerMs ?? null, r.correction?.upperMs ?? null, r.tieGroup] as const)
    };
  });
}

describe('导出与重放', () => {
  it('导出包含摘要、修订参数、假设与可验证 manifest', async () => {
    const db = await seededDB();
    const bundle = await buildBundle(db);
    expect(bundle.format).toBe('event-evidence-puzzle/v1');
    expect(bundle.manifest.counts.events).toBeGreaterThanOrEqual(9);
    expect(bundle.manifest.counts.revisions).toBe(2);
    expect(bundle.manifest.anchorsPerRevision).toEqual({ 'rev-1': 4, 'rev-2': 6 });
    expect(bundle.manifest.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.events.every((e) => e.contentDigest.match(/^[0-9a-f]{64}$/))).toBe(true);
    expect(bundle.hypotheses).toHaveLength(2);
    expect(bundle.quarantine.length).toBeGreaterThanOrEqual(3);
    close(db);
  });

  it('重放到空库后排序、并列组、来源收据完全一致', async () => {
    const src = await seededDB();
    const bundle = await buildBundle(src);
    const before = orderSignatures(src);

    const dst = freshDB();
    const report = await replayBundle(dst, JSON.parse(JSON.stringify(bundle)));
    expect(report.revisions).toBe(2);
    expect(report.hypotheses).toBe(2);
    expect(report.quarantine).toBeGreaterThanOrEqual(3);
    expect(report.conflicts).toContain('evt_INC-3');

    expect(orderSignatures(dst)).toEqual(before);

    const events = listEvents(dst);
    const srcEvents = listEvents(src);
    expect(events.map((e) => [e.eventKey, e.contentDigest, e.receipts.length, e.conflict])).toEqual(
      srcEvents.map((e) => [e.eventKey, e.contentDigest, e.receipts.length, e.conflict])
    );
    const receipts = dbReceipts(dst);
    expect(dbReceipts(src)).toEqual(receipts);

    const hyps = listHypotheses(dst);
    expect(hyps.find((h) => h.hypothesisId === 'hyp-pay-chain')!.eventKeys).toContain('evt_INC-3');
    expect(hyps.find((h) => h.hypothesisId === 'hyp-deploy-chain')!.eventKeys).toContain('evt_INC-3');

    // 假设没有写回事件：事件记录不含任何假设字段
    const evt3 = events.find((e) => e.eventKey === 'evt_INC-3')!;
    expect(Object.keys(evt3.canonical).sort()).toEqual(['detail', 'id', 'observedAt', 'type']);

    expect(listQuarantine(dst).map((q) => q.quarantineId).sort()).toEqual(
      listQuarantine(src).map((q) => q.quarantineId).sort()
    );
    close(src);
    close(dst);
  });

  it('重复重放同一导出包是幂等的', async () => {
    const src = await seededDB();
    const bundle = await buildBundle(src);
    const dst = freshDB();
    await replayBundle(dst, JSON.parse(JSON.stringify(bundle)));
    const again = await replayBundle(dst, JSON.parse(JSON.stringify(bundle)));
    expect(again.imported).toBeGreaterThan(0);
    expect(again.mergedReceipts).toBe(again.imported);
    const count = dbReceipts(dst).length;
    expect(dbReceipts(src).length).toBe(count);
    close(src);
    close(dst);
  });

  it('manifest 能发现被篡改的导出包', async () => {
    const src = await seededDB();
    const bundle = (await buildBundle(src)) as unknown as Record<string, unknown>;
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.note = 'attacker touch';
    const dst = freshDB();
    await expect(replayBundle(dst, tampered)).rejects.toBeInstanceOf(ManifestError);

    const bodyChanged = JSON.parse(JSON.stringify(bundle));
    (bodyChanged.events as unknown[])[0] = { injected: true };
    await expect(replayBundle(dst, bodyChanged)).rejects.toMatchObject({ message: /manifest/ });
    close(src);
    close(dst);
  });
});

function dbReceipts(db: ReturnType<typeof freshDB>) {
  const rows = db
    .prepare('SELECT event_key, source, raw_digest, line_index, received_at FROM receipts ORDER BY event_key, source, raw_digest')
    .all() as unknown as { event_key: string; source: string; raw_digest: string; line_index: number | null; received_at: string }[];
  return rows.map((r) => [r.event_key, r.source, r.raw_digest, r.line_index, r.received_at]);
}
