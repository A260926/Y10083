import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/server/store.js';
import { replayRevisionTimeline } from '../src/server/revisions.js';
import { buildExport } from '../src/server/export.js';
import { replayBundle } from '../src/server/replay.js';

let counter = 0;
export async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'evidence-'));
  const file = path.join(dir, `test-${process.pid}-${counter++}.sqlite`);
  return Store.open(file);
}

export function storedOrder(store: Store, revId: number) {
  const r = replayRevisionTimeline(store, revId)!;
  return r.storedOrder.map((row: any) => ({
    event_id: row.event_id,
    corr_ms: row.corr_ms,
    lo_ms: row.lo_ms,
    hi_ms: row.hi_ms,
    tie_group: row.tie_group,
    tie_size: row.tie_size,
    live: row.live,
  }));
}

export function roundtrip(store: Store) {
  const bundle = buildExport(store);
  return replayBundle(store, bundle);
}
