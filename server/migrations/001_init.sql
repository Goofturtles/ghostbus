-- GhostBus Tier 0 schema. Standard Postgres SQL only (runs identically on pg and PGlite).
-- Every table carries an `agency` seam so a second city can be added without a rewrite.
-- Statements are split on top-level semicolons by the migration runner, so keep each
-- statement single and never place a semicolon inside a string literal or comment.

CREATE TABLE IF NOT EXISTS cities (
  agency  TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  tz      TEXT NOT NULL,
  min_lat DOUBLE PRECISION,
  min_lon DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  max_lon DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS routes (
  agency     TEXT NOT NULL,
  route_id   TEXT NOT NULL,
  short_name TEXT,
  long_name  TEXT,
  route_type SMALLINT,
  color      TEXT,
  PRIMARY KEY (agency, route_id)
);

CREATE TABLE IF NOT EXISTS stops (
  agency              TEXT NOT NULL,
  stop_id             TEXT NOT NULL,
  name                TEXT,
  lat                 DOUBLE PRECISION,
  lon                 DOUBLE PRECISION,
  wheelchair_boarding SMALLINT,
  PRIMARY KEY (agency, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_stops_agency ON stops (agency);

CREATE TABLE IF NOT EXISTS trips (
  agency                TEXT NOT NULL,
  trip_id               TEXT NOT NULL,
  route_id              TEXT,
  service_id            TEXT,
  headsign              TEXT,
  direction_id          SMALLINT,
  shape_id              TEXT,
  wheelchair_accessible SMALLINT,
  PRIMARY KEY (agency, trip_id)
);

CREATE INDEX IF NOT EXISTS idx_trips_service ON trips (agency, service_id);

CREATE TABLE IF NOT EXISTS stop_times (
  agency        TEXT NOT NULL,
  trip_id       TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  stop_id       TEXT NOT NULL,
  arrival_s     INTEGER,
  departure_s   INTEGER,
  PRIMARY KEY (agency, trip_id, stop_sequence)
);

-- The PK prefix (agency, trip_id) already serves lookups by trip, so no separate
-- (agency, trip_id) index is needed. Keep only the stop/time lookup index.
CREATE INDEX IF NOT EXISTS idx_stop_times_stop_dep ON stop_times (agency, stop_id, departure_s);

CREATE TABLE IF NOT EXISTS shapes (
  agency   TEXT NOT NULL,
  shape_id TEXT NOT NULL,
  points   JSONB NOT NULL,
  PRIMARY KEY (agency, shape_id)
);

CREATE TABLE IF NOT EXISTS calendar (
  agency     TEXT NOT NULL,
  service_id TEXT NOT NULL,
  mon        BOOLEAN NOT NULL,
  tue        BOOLEAN NOT NULL,
  wed        BOOLEAN NOT NULL,
  thu        BOOLEAN NOT NULL,
  fri        BOOLEAN NOT NULL,
  sat        BOOLEAN NOT NULL,
  sun        BOOLEAN NOT NULL,
  start_date INTEGER NOT NULL,
  end_date   INTEGER NOT NULL,
  PRIMARY KEY (agency, service_id)
);

CREATE TABLE IF NOT EXISTS calendar_dates (
  agency         TEXT NOT NULL,
  service_id     TEXT NOT NULL,
  date           INTEGER NOT NULL,
  exception_type SMALLINT NOT NULL,
  PRIMARY KEY (agency, service_id, date)
);

CREATE TABLE IF NOT EXISTS trip_delay_obs (
  agency       TEXT NOT NULL,
  route_id     TEXT,
  stop_id      TEXT,
  trip_id      TEXT,
  hour_of_week SMALLINT,
  delay_s      INTEGER,
  service_date INTEGER NOT NULL,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agency, trip_id, stop_id, service_date)
);

CREATE INDEX IF NOT EXISTS idx_delay_obs_key ON trip_delay_obs (agency, route_id, stop_id, hour_of_week);

CREATE INDEX IF NOT EXISTS idx_delay_obs_ts ON trip_delay_obs (ts);

CREATE TABLE IF NOT EXISTS agg_delay (
  agency       TEXT NOT NULL,
  route_id     TEXT NOT NULL,
  stop_id      TEXT NOT NULL,
  hour_of_week SMALLINT NOT NULL,
  n            INTEGER,
  p25          INTEGER,
  p50          INTEGER,
  p75          INTEGER,
  updated      TIMESTAMPTZ,
  PRIMARY KEY (agency, route_id, stop_id, hour_of_week)
);

CREATE TABLE IF NOT EXISTS ghosts (
  agency          TEXT NOT NULL,
  trip_id         TEXT NOT NULL,
  route_id        TEXT,
  scheduled_start TIMESTAMPTZ NOT NULL,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL CHECK (kind IN ('ghost','cancelled')),
  PRIMARY KEY (agency, trip_id, scheduled_start)
);

CREATE TABLE IF NOT EXISTS service_alerts (
  agency           TEXT NOT NULL,
  alert_id         TEXT NOT NULL,
  effect           TEXT,
  cause            TEXT,
  header           TEXT,
  description      TEXT,
  active_start     TIMESTAMPTZ,
  active_end       TIMESTAMPTZ,
  informed         JSONB,
  is_accessibility BOOLEAN,
  PRIMARY KEY (agency, alert_id)
);
