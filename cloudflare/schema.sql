-- Anime Arena Top — Cloudflare D1 schema
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  nickname       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email          TEXT NOT NULL COLLATE NOCASE UNIQUE,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  age            INTEGER NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'player',
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS players (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  coins             INTEGER NOT NULL DEFAULT 0,
  diamonds          INTEGER NOT NULL DEFAULT 0,
  tokens            INTEGER NOT NULL DEFAULT 8,
  tokens_updated_at INTEGER NOT NULL,
  level             INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,
  losses            INTEGER NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  favorite_hero     TEXT,
  map_id            TEXT NOT NULL DEFAULT 'std',
  settings          TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_states (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owned_heroes (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hero_id      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'start',
  price        INTEGER NOT NULL DEFAULT 0,
  currency     TEXT,
  acquired_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, hero_id)
);

CREATE TABLE IF NOT EXISTS owned_maps (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  map_id      TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, map_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  currency      TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref           TEXT,
  meta          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS level_runs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      INTEGER NOT NULL,
  won        INTEGER NOT NULL,
  reward     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_level_runs_user ON level_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tournaments (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id         TEXT NOT NULL,
  hero_id        TEXT,
  size           INTEGER NOT NULL DEFAULT 32,
  selection_cost INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  champion       INTEGER,
  forfeit        INTEGER,
  placement      TEXT,
  wins           INTEGER,
  base_total     REAL,
  total_awarded  REAL,
  coins          INTEGER,
  diamonds       INTEGER,
  payload        TEXT,
  created_at     INTEGER NOT NULL,
  settled_at     INTEGER,
  UNIQUE (user_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_tournaments_user ON tournaments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS live_tournaments (
  id               TEXT PRIMARY KEY,
  number           INTEGER NOT NULL,
  size             INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'registration',
  opens_at         INTEGER NOT NULL,
  deadline_at      INTEGER NOT NULL,
  start_at         INTEGER NOT NULL,
  started_at       INTEGER,
  completed_at     INTEGER,
  next_match_at    INTEGER,
  champion_user_id TEXT,
  payload          TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_tournaments_status ON live_tournaments(status, created_at DESC);

CREATE TABLE IF NOT EXISTS live_entries (
  tournament_id TEXT NOT NULL REFERENCES live_tournaments(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  hero_id       TEXT NOT NULL,
  hero_tier     TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_live_entries_tournament ON live_entries(tournament_id, seed);

CREATE TABLE IF NOT EXISTS live_matches (
  tournament_id TEXT NOT NULL REFERENCES live_tournaments(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  round         INTEGER NOT NULL,
  slot          INTEGER NOT NULL,
  a             TEXT,
  b             TEXT,
  winner        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  starts_at     INTEGER,
  ends_at       INTEGER,
  ended_at      INTEGER,
  timeline      TEXT,
  PRIMARY KEY (tournament_id, id)
);
CREATE INDEX IF NOT EXISTS idx_live_matches_tournament ON live_matches(tournament_id, round, slot);

CREATE TABLE IF NOT EXISTS admin_audit (
  id             TEXT PRIMARY KEY,
  admin_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action         TEXT NOT NULL,
  currency       TEXT NOT NULL,
  amount         INTEGER NOT NULL,
  note           TEXT,
  balance_before INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
