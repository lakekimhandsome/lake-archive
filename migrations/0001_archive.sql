CREATE TABLE IF NOT EXISTS sites (
  hostname TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  favicon_url TEXT,
  og_image_url TEXT,
  repository_url TEXT,
  repository_verified_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_online_at TEXT,
  current_status TEXT NOT NULL DEFAULT 'unknown' CHECK(current_status IN ('unknown','online','offline','blocked')),
  discovery_sources TEXT NOT NULL DEFAULT '[]',
  matching_evidence TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  visibility TEXT NOT NULL DEFAULT 'auto' CHECK(visibility IN ('auto','public','private')),
  auto_public INTEGER NOT NULL DEFAULT 0 CHECK(auto_public IN (0,1))
);
CREATE INDEX IF NOT EXISTS sites_visibility ON sites(visibility, auto_public);
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed')),
  discovered INTEGER NOT NULL DEFAULT 0,
  checked INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS sync_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_allowed_at INTEGER NOT NULL
);
