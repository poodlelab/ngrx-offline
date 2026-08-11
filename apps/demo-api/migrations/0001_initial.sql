PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE trips (
  workspace_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'travelling', 'complete', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, client_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE travel_days (
  workspace_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  trip_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, client_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, trip_id) REFERENCES trips(workspace_id, id)
);

CREATE TABLE place_visits (
  workspace_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  travel_day_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country_code TEXT NOT NULL,
  arrived_at TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'visited', 'skipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, client_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, travel_day_id) REFERENCES travel_days(workspace_id, id)
);

CREATE TABLE memories (
  workspace_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  place_visit_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('place', 'taste', 'sound', 'moment')),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, client_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, place_visit_id) REFERENCES place_visits(workspace_id, id)
);

CREATE TABLE day_reflections (
  workspace_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  travel_day_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  mood TEXT NOT NULL CHECK (mood IN ('radiant', 'calm', 'curious', 'tired')),
  weather TEXT,
  client_created_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, client_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, travel_day_id) REFERENCES travel_days(workspace_id, id)
);

CREATE TABLE idempotency_results (
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  location TEXT,
  etag TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE test_behaviors (
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  behavior TEXT NOT NULL,
  delay_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE request_diagnostics (
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  deliveries INTEGER NOT NULL DEFAULT 0,
  mutations INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE rate_limits (
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (subject, window_start)
);

CREATE INDEX trips_workspace_id ON trips(workspace_id, id);
CREATE INDEX travel_days_trip ON travel_days(workspace_id, trip_id, date, id);
CREATE INDEX place_visits_day ON place_visits(workspace_id, travel_day_id, arrived_at, id);
CREATE INDEX memories_visit ON memories(workspace_id, place_visit_id, sort_order, id);
CREATE INDEX reflections_day ON day_reflections(workspace_id, travel_day_id, client_created_at, id);
CREATE INDEX workspaces_expiry ON workspaces(expires_at, id);
CREATE INDEX idempotency_created ON idempotency_results(created_at);
CREATE INDEX diagnostics_updated ON request_diagnostics(updated_at);
