-- Atlas Journal replaces the original demonstration domain. Existing local D1 instances
-- may already have applied 0001, so rebuild only disposable domain tables.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS day_reflections;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS place_visits;
DROP TABLE IF EXISTS travel_days;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS checklist_entries;
DROP TABLE IF EXISTS work_orders;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS customers;

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

CREATE INDEX trips_workspace_id ON trips(workspace_id, id);
CREATE INDEX travel_days_trip ON travel_days(workspace_id, trip_id, date, id);
CREATE INDEX place_visits_day ON place_visits(workspace_id, travel_day_id, arrived_at, id);
CREATE INDEX memories_visit ON memories(workspace_id, place_visit_id, sort_order, id);
CREATE INDEX reflections_day ON day_reflections(workspace_id, travel_day_id, client_created_at, id);

PRAGMA foreign_keys = ON;
