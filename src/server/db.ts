export async function openRawDatabase(filename: string): Promise<any> {
  const warningFilter = (warning: Error & { name: string; message: string }) => {
    if (warning.name === 'ExperimentalWarning' && String(warning.message).includes('SQLite')) {
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(warning.stack ?? warning.message);
  };
  process.removeAllListeners('warning');
  process.on('warning', warningFilter);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unknown',
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  content_canonical TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_receipt_id INTEGER,
  conflict INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS receipt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES event(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  raw_text TEXT NOT NULL,
  raw_sha TEXT NOT NULL,
  observed_at_ms INTEGER,
  received_at_ms INTEGER NOT NULL,
  batch_id INTEGER REFERENCES batch(id),
  line_no INTEGER,
  UNIQUE(event_id, source_id, raw_sha)
);
CREATE TABLE IF NOT EXISTS event_conflict (
  event_id TEXT NOT NULL REFERENCES event(id),
  content_sha TEXT NOT NULL,
  receipt_id INTEGER NOT NULL,
  detected_at_ms INTEGER NOT NULL,
  PRIMARY KEY (event_id, content_sha)
);
CREATE TABLE IF NOT EXISTS batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  received_at_ms INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES batch(id),
  line_no INTEGER,
  source_id TEXT,
  raw_text TEXT NOT NULL,
  raw_sha TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anchor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES source(id),
  observed_at_ms INTEGER NOT NULL,
  true_at_ms INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  algo_version TEXT NOT NULL,
  anchors_json TEXT NOT NULL,
  anchors_signature TEXT NOT NULL,
  base_revision_id INTEGER REFERENCES revision(id),
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revision_event (
  revision_id INTEGER NOT NULL REFERENCES revision(id),
  event_id TEXT NOT NULL REFERENCES event(id),
  corr_ms INTEGER,
  half_width_ms INTEGER,
  lo_ms INTEGER,
  hi_ms INTEGER,
  tie_group INTEGER,
  tie_size INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  PRIMARY KEY (revision_id, event_id)
);
CREATE TABLE IF NOT EXISTS hypothesis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  basis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hypothesis_member (
  hypothesis_id INTEGER NOT NULL REFERENCES hypothesis(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES event(id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (hypothesis_id, event_id)
);
`;
