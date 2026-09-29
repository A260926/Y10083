import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_key TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  primary_source TEXT NOT NULL,
  conflict INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_variants (
  event_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_key, content_digest)
);

CREATE TABLE IF NOT EXISTS raw_archive (
  raw_digest TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  bytes_length INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_key TEXT NOT NULL PRIMARY KEY,
  event_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw_digest TEXT NOT NULL,
  line_index INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (event_key, source, raw_digest),
  FOREIGN KEY (event_key) REFERENCES events(event_key)
);

CREATE TABLE IF NOT EXISTS anchors (
  anchor_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_kind TEXT NOT NULL,
  reference_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  revision_id TEXT PRIMARY KEY,
  parent_id TEXT,
  based_on TEXT,
  anchor_digest TEXT NOT NULL,
  anchors_json TEXT NOT NULL,
  algo_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence_note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hypothesis_events (
  hypothesis_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  PRIMARY KEY (hypothesis_id, event_key),
  FOREIGN KEY (hypothesis_id) REFERENCES hypotheses(hypothesis_id)
);

CREATE TABLE IF NOT EXISTS quarantine (
  quarantine_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  line_index INTEGER
);

CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE INDEX IF NOT EXISTS idx_receipts_event ON receipts(event_key);
CREATE INDEX IF NOT EXISTS idx_quarantine_source ON quarantine(source);
`;

export function openDB(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
