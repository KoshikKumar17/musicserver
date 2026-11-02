-- Index of tracks already stored in the Telegram group (the files themselves live in Telegram).
CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL,
  message_id  INTEGER,
  file_name   TEXT NOT NULL,
  size_mb     TEXT,
  title       TEXT,
  artist      TEXT,
  album       TEXT,
  created_at  INTEGER NOT NULL
);

-- Build state, so concurrent requests/isolates don't build or upload the same track twice.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  state       TEXT NOT NULL,   -- 'processing' | 'failed'
  error       TEXT,
  updated_at  INTEGER NOT NULL
);
