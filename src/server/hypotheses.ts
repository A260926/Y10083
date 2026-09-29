import type { DatabaseSync } from 'node:sqlite';
import type { Hypothesis } from '../shared/types.js';

export interface HypothesisInput {
  hypothesisId?: string;
  title: string;
  evidence: string;
  confidenceNote: string;
  eventKeys: string[];
}

export function listHypotheses(db: DatabaseSync): Hypothesis[] {
  const rows = db.prepare('SELECT * FROM hypotheses ORDER BY created_at, hypothesis_id').all() as {
    hypothesis_id: string;
    title: string;
    evidence: string;
    confidence_note: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    hypothesisId: row.hypothesis_id,
    title: row.title,
    evidence: row.evidence,
    confidenceNote: row.confidence_note,
    eventKeys: (
      db
        .prepare('SELECT event_key FROM hypothesis_events WHERE hypothesis_id = ? ORDER BY event_key')
        .all(row.hypothesis_id) as { event_key: string }[]
    ).map((r) => r.event_key),
    createdAt: row.created_at
  }));
}

export function addHypothesis(db: DatabaseSync, input: HypothesisInput): Hypothesis {
  if (!input.title?.trim()) throw new Error('假设必须有标题');
  if (!input.evidence?.trim()) throw new Error('假设必须保存依据说明');
  if (!input.confidenceNote?.trim()) throw new Error('假设必须保存置信说明');
  if (!Array.isArray(input.eventKeys) || input.eventKeys.length === 0) throw new Error('假设至少关联一个事件');
  const existingKeys = new Set(
    (db.prepare('SELECT event_key FROM events').all() as { event_key: string }[]).map((r) => r.event_key)
  );
  for (const key of input.eventKeys) {
    if (!existingKeys.has(key)) throw new Error(`关联事件不存在: ${key}`);
  }
  const uniqueKeys = [...new Set(input.eventKeys)].sort();
  const hypothesisId = input.hypothesisId?.trim() || `hyp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO hypotheses (hypothesis_id, title, evidence, confidence_note, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(hypothesisId, input.title, input.evidence, input.confidenceNote, createdAt);
  const stmt = db.prepare('INSERT INTO hypothesis_events (hypothesis_id, event_key) VALUES (?, ?)');
  for (const key of uniqueKeys) stmt.run(hypothesisId, key);
  return {
    hypothesisId,
    title: input.title,
    evidence: input.evidence,
    confidenceNote: input.confidenceNote,
    eventKeys: uniqueKeys,
    createdAt
  };
}
