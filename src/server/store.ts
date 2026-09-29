import { SCHEMA_SQL, openRawDatabase } from './db.js';
import { sha256Hex } from './crypto.js';
import { parseEventLine, splitNdjson } from './ingest.js';
import type {
  AnchorRow,
  AnchorSnapshot,
  EventWithReceipts,
  HypothesisRow,
  QuarantineRow,
  ReceiptRow,
  RevisionRow,
  SourceRow,
} from './types.js';

export interface ImportResult {
  batchId: number | null;
  accepted: number;
  rejected: number;
  duplicates: number;
  conflicts: string[];
  quarantine: Array<{ line_no: number | null; reason: string; raw_sha: string }>;
}

export class Store {
  private constructor(public db: any) {}

  static async open(filename: string): Promise<Store> {
    const db = await openRawDatabase(filename);
    db.exec(SCHEMA_SQL);
    return new Store(db);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): any {
    return this.db.prepare(sql);
  }

  private txDepth = 0;

  transaction<T>(fn: () => T): T {
    const depth = ++this.txDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 1) {
      this.db.exec('BEGIN IMMEDIATE');
    } else {
      this.db.exec(`SAVEPOINT ${savepoint}`);
    }
    try {
      const result = fn();
      if (depth === 1) {
        this.db.exec('COMMIT');
      } else {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      this.txDepth--;
      return result;
    } catch (err) {
      if (depth === 1) {
        this.db.exec('ROLLBACK');
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      this.txDepth--;
      throw err;
    }
  }

  ensureSource(id: string, name?: string, kind?: string): void {
    const existing = this.prepare('SELECT id FROM source WHERE id = ?').get(id);
    if (!existing) {
      this.prepare('INSERT INTO source (id, name, kind, created_at_ms) VALUES (?, ?, ?, ?)').run(
        id,
        name ?? id,
        kind ?? 'unknown',
        Date.now(),
      );
    }
  }

  listSources(): SourceRow[] {
    return this.prepare('SELECT id, name, kind, created_at_ms AS created_at FROM source ORDER BY id').all();
  }

  getSource(id: string): SourceRow | undefined {
    return this.prepare('SELECT id, name, kind, created_at_ms AS created_at FROM source WHERE id = ?').get(id);
  }

  importLines(input: string, defaultSource?: string): ImportResult {
    return this.transaction(() => {
      const now = Date.now();
      const batchRes = this.prepare('INSERT INTO batch (source_id, received_at_ms) VALUES (?, ?)').run(
        defaultSource ?? null,
        now,
      );
      const batchId = Number(batchRes.lastInsertRowid);
      const lines = splitNdjson(input);
      let accepted = 0;
      let rejected = 0;
      let duplicates = 0;
      const conflicts: string[] = [];
      const quarantine: ImportResult['quarantine'] = [];

      for (const { lineNo, text } of lines) {
        const parsed = parseEventLine(text);
        const rawSha = sha256Hex(Buffer.from(text, 'utf8'));
        if ('reason' in parsed) {
          rejected++;
          this.prepare(
            'INSERT INTO quarantine (batch_id, line_no, source_id, raw_text, raw_sha, reason, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(batchId, lineNo, defaultSource ?? null, text, rawSha, parsed.reason, now);
          quarantine.push({ line_no: lineNo, reason: parsed.reason, raw_sha: rawSha });
          continue;
        }
        this.ensureSource(parsed.sourceId, parsed.sourceName, parsed.sourceKind);
        const event = this.prepare('SELECT * FROM event WHERE id = ?').get(parsed.eventId);
        let eventConflict = 0;
        if (!event) {
          this.prepare(
            'INSERT INTO event (id, content_canonical, content_sha, summary, first_receipt_id, conflict) VALUES (?, ?, ?, ?, NULL, 0)',
          ).run(parsed.eventId, parsed.contentCanonical, parsed.contentSha, parsed.summary);
        } else if (event.content_sha !== parsed.contentSha) {
          eventConflict = 1;
          this.prepare('UPDATE event SET conflict = 1 WHERE id = ?').run(parsed.eventId);
          this.prepare(
            'INSERT OR IGNORE INTO event_conflict (event_id, content_sha, receipt_id, detected_at_ms) VALUES (?, ?, NULL, ?)',
          ).run(parsed.eventId, parsed.contentSha, now);
          if (!conflicts.includes(parsed.eventId)) conflicts.push(parsed.eventId);
        }
        const receiptRes = this.prepare(
          `INSERT INTO receipt (event_id, source_id, raw_text, raw_sha, observed_at_ms, received_at_ms, batch_id, line_no)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id, source_id, raw_sha) DO NOTHING`,
        ).run(
          parsed.eventId,
          parsed.sourceId,
          text,
          rawSha,
          parsed.observedAtMs,
          now,
          batchId,
          lineNo,
        );
        if (Number(receiptRes.changes) === 0) {
          duplicates++;
        } else {
          accepted++;
          this.prepare(
            'INSERT OR IGNORE INTO event_conflict (event_id, content_sha, receipt_id, detected_at_ms) VALUES (?, ?, ?, ?)',
          ).run(parsed.eventId, parsed.contentSha, Number(receiptRes.lastInsertRowid), now);
          if (eventConflict && !conflicts.includes(parsed.eventId)) conflicts.push(parsed.eventId);
        }
      }
      this.prepare('UPDATE batch SET accepted_count = ?, rejected_count = ? WHERE id = ?').run(
        accepted,
        rejected,
        batchId,
      );
      return { batchId, accepted, rejected, duplicates, conflicts, quarantine };
    });
  }

  listEventsWithReceipts(): EventWithReceipts[] {
    const events = this.prepare('SELECT * FROM event ORDER BY id').all() as Array<any>;
    return events.map((ev) => ({
      id: ev.id,
      content_canonical: ev.content_canonical,
      content_sha: ev.content_sha,
      summary: ev.summary,
      first_receipt_id: ev.first_receipt_id,
      conflict: ev.conflict,
      receipts: this.prepare('SELECT * FROM receipt WHERE event_id = ? ORDER BY id').all(ev.id) as ReceiptRow[],
    }));
  }

  listReceipts(): ReceiptRow[] {
    return this.prepare('SELECT * FROM receipt ORDER BY id').all();
  }

  listQuarantine(): QuarantineRow[] {
    return this.prepare('SELECT * FROM quarantine ORDER BY id').all();
  }

  addAnchor(sourceId: string, observedAtMs: number, trueAtMs: number, note = ''): AnchorRow {
    this.ensureSource(sourceId);
    const now = Date.now();
    const res = this.prepare(
      'INSERT INTO anchor (source_id, observed_at_ms, true_at_ms, note, created_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run(sourceId, observedAtMs, trueAtMs, note, now);
    return this.prepare('SELECT * FROM anchor WHERE id = ?').get(Number(res.lastInsertRowid));
  }

  listAnchors(): AnchorRow[] {
    return this.prepare('SELECT * FROM anchor ORDER BY source_id, observed_at_ms').all();
  }

  listRevisions(): RevisionRow[] {
    return this.prepare('SELECT * FROM revision ORDER BY id').all();
  }

  getRevision(id: number): (RevisionRow & { anchors: AnchorSnapshot[] }) | undefined {
    const row = this.prepare('SELECT * FROM revision WHERE id = ?').get(id);
    if (!row) return undefined;
    return { ...row, anchors: JSON.parse(row.anchors_json) as AnchorSnapshot[] };
  }

  addHypothesis(title: string, basis: string, confidence: string, eventIds: string[]): HypothesisRow {
    return this.transaction(() => {
      const now = Date.now();
      const res = this.prepare(
        'INSERT INTO hypothesis (title, basis, confidence, created_at_ms) VALUES (?, ?, ?, ?)',
      ).run(title, basis, confidence, now);
      const id = Number(res.lastInsertRowid);
      eventIds.forEach((eventId, idx) => {
        this.prepare(
          'INSERT INTO hypothesis_member (hypothesis_id, event_id, seq) VALUES (?, ?, ?)',
        ).run(id, eventId, idx);
      });
      return this.prepare('SELECT * FROM hypothesis WHERE id = ?').get(id);
    });
  }

  listHypotheses(): Array<HypothesisRow & { event_ids: string[] }> {
    const rows = this.prepare('SELECT * FROM hypothesis ORDER BY id').all() as HypothesisRow[];
    return rows.map((h) => ({
      ...h,
      event_ids: this.prepare(
        'SELECT event_id FROM hypothesis_member WHERE hypothesis_id = ? ORDER BY seq',
      ).all(h.id).map((r: any) => r.event_id),
    }));
  }
}
