import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB } from '../src/server/db.js';
import { installSeed } from '../src/server/seed.js';
import type { DatabaseSync } from 'node:sqlite';

export function freshDB(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  return openDB(join(dir, 'test.sqlite'));
}

export async function seededDB(): Promise<DatabaseSync> {
  const db = freshDB();
  await installSeed(db);
  return db;
}

export function close(db: DatabaseSync): void {
  db.close();
}
