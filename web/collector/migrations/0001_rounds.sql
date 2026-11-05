CREATE TABLE IF NOT EXISTS rounds (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  match_id TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('game','test')),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sha256 TEXT NOT NULL,
  human_actions INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(match_id, round_no)
);
CREATE INDEX IF NOT EXISTS rounds_export ON rounds(kind, seq);
