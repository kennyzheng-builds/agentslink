-- AgentsLink Stats D1 Schema

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- 'create', 'reply', 'read_request', 'read_reply'
  request_id TEXT,
  user_id TEXT,
  category TEXT,
  content_length INTEGER DEFAULT 0,
  created_at TEXT NOT NULL      -- ISO 8601 timestamp
);

CREATE INDEX IF NOT EXISTS idx_events_type_date ON events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT NOT NULL,            -- 'YYYY-MM-DD'
  type TEXT NOT NULL,            -- 'create', 'reply', 'read_request', 'read_reply'
  count INTEGER DEFAULT 0,
  unique_users INTEGER DEFAULT 0,
  PRIMARY KEY (date, type)
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
