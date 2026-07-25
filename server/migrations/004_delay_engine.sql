-- Phase 6: the real delay engine.
--
-- The TTC GTFS-realtime feed publishes NO delay field (own-property census: 0 of 23,476
-- StopTimeEvents, 0 of 1,392 TripUpdates on a live snapshot). Genuine delay must therefore
-- be computed as (predicted_time - scheduled_time) with scheduled_time coming from OUR OWN
-- seeded static GTFS. That requires matching each realtime trip to a static trip without a
-- usable trip_id, which these tables make auditable and recomputable.
--
-- Additive only: nothing is dropped, no row is deleted. Standard Postgres SQL, so it runs
-- identically on pg (Neon) and PGlite. Keep one statement per semicolon and no semicolons
-- inside string literals -- the migration runner splits on top-level semicolons.

-- Running geographic evidence for each RT stop, accumulated from STOPPED_AT vehicles.
-- Raw sums rather than a maintained mean, so the centroid is always recomputable and the
-- vote count behind it is visible.
CREATE TABLE IF NOT EXISTS rt_stop_anchor (
  agency     TEXT NOT NULL,
  rt_stop_id TEXT NOT NULL,
  route_id   TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  sum_lat    DOUBLE PRECISION NOT NULL DEFAULT 0,
  sum_lon    DOUBLE PRECISION NOT NULL DEFAULT 0,
  n_vehicles INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, rt_stop_id, route_id)
);

-- Every geometric vote, kept raw so the promoted winner in rt_stop_xwalk is always
-- recomputable from evidence and a disagreement can be inspected rather than guessed at.
CREATE TABLE IF NOT EXISTS rt_stop_xwalk_votes (
  agency      TEXT NOT NULL,
  rt_stop_id  TEXT NOT NULL,
  board_tag   TEXT NOT NULL,
  stop_id     TEXT NOT NULL,
  route_id    TEXT NOT NULL,
  source      TEXT NOT NULL,
  votes       INTEGER NOT NULL DEFAULT 0,
  sum_resid_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, rt_stop_id, board_tag, stop_id, route_id, source)
);

-- The learned crosswalk. board_tag scopes it so a re-seed invalidates it wholesale
-- instead of silently carrying a previous board's stop identities into a new one.
CREATE TABLE IF NOT EXISTS rt_stop_xwalk (
  agency            TEXT NOT NULL,
  rt_stop_id        TEXT NOT NULL,
  board_tag         TEXT NOT NULL,
  stop_id           TEXT NOT NULL,
  votes             INTEGER NOT NULL,
  distinct_patterns INTEGER NOT NULL,
  geo_resid_m       DOUBLE PRECISION,
  source            TEXT NOT NULL,
  state             TEXT NOT NULL,
  confidence        DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, rt_stop_id, board_tag)
);

CREATE INDEX IF NOT EXISTS idx_rt_stop_xwalk_state ON rt_stop_xwalk (agency, board_tag, state);

-- RT pattern -> static pattern resolution, with the iteration that resolved it so the
-- value of transitive propagation is measurable rather than asserted.
CREATE TABLE IF NOT EXISTS rt_pattern (
  agency            TEXT NOT NULL,
  rt_pattern_id     TEXT NOT NULL,
  board_tag         TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  seq_stops         JSONB NOT NULL,
  n_stops           INTEGER NOT NULL,
  static_pattern_id TEXT,
  resid_m           DOUBLE PRECISION,
  n_anchors         INTEGER,
  resolve_iter      INTEGER,
  state             TEXT NOT NULL,
  updated           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, rt_pattern_id, board_tag)
);

CREATE INDEX IF NOT EXISTS idx_rt_pattern_state ON rt_pattern (agency, board_tag, state);

-- One binding per RT trip per service date. WRITTEN ONCE, never re-derived: re-solving a
-- binding under a plausible-delay band would truncate the delay distribution and bias the
-- published percentiles toward flattering the agency.
CREATE TABLE IF NOT EXISTS rt_trip_binding (
  agency             TEXT NOT NULL,
  service_date       INTEGER NOT NULL,
  rt_trip_id         TEXT NOT NULL,
  trip_id            TEXT,
  rt_pattern_id      TEXT NOT NULL,
  static_pattern_id  TEXT,
  route_id           TEXT,
  method             TEXT NOT NULL,
  state              TEXT NOT NULL,
  first_stop_resid_s INTEGER,
  margin_s           INTEGER,
  headway_s          INTEGER,
  anchors            INTEGER,
  agree              INTEGER,
  confidence         TEXT,
  bound_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, service_date, rt_trip_id)
);

-- Load-bearing: two RT trips claiming the same static trip becomes a database error
-- rather than two silently wrong delay series.
CREATE UNIQUE INDEX IF NOT EXISTS rt_trip_binding_static_uniq
  ON rt_trip_binding (agency, service_date, trip_id) WHERE trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rt_trip_binding_state ON rt_trip_binding (agency, service_date, state);

-- Scheduled slots consumed by a binding, so a slot that passes its departure time
-- unclaimed is a genuine ghost candidate rather than an artifact of a failed match.
CREATE TABLE IF NOT EXISTS sched_slot_claim (
  agency       TEXT NOT NULL,
  service_date INTEGER NOT NULL,
  trip_id      TEXT NOT NULL,
  rt_trip_id   TEXT,
  state        TEXT NOT NULL,
  updated      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency, service_date, trip_id)
);

-- Observation record. BOTH epochs are stored so delay_s is recomputable from the row
-- alone and any future change to the anchor, tolerance, or settle rule can be
-- re-evaluated against stored rows without re-collecting a single day of feed.
ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS static_trip_id TEXT;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS stop_sequence INTEGER;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS sched_epoch_s BIGINT;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS event_epoch_s BIGINT;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS method TEXT;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS confidence TEXT;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS xwalk_conf DOUBLE PRECISION;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS match_margin_s INTEGER;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS headway_s INTEGER;

ALTER TABLE trip_delay_obs ADD COLUMN IF NOT EXISTS board_tag TEXT;

-- Quarantine the legacy artifact rows rather than deleting them: they are the forensic
-- record that the feed publishes no delay, they age out under the existing 14-day
-- retention prune, and a destructive statement on a shared database is not warranted.
-- After this statement, method IS NULL is impossible for any pre-existing row.
UPDATE trip_delay_obs SET method = 'legacy_feed_delay_zero' WHERE method IS NULL;

-- Loop routes visit the same stop twice on one trip. The pre-existing
-- UNIQUE (agency, trip_id, stop_id, service_date) cannot express that, so add a
-- sequence-aware key alongside it. The old constraint is deliberately NOT dropped:
-- new rows satisfy it too (trip_id remains the RT trip id) and dropping a constraint on
-- a shared production database is a destructive change.
CREATE UNIQUE INDEX IF NOT EXISTS trip_delay_obs_rt_seq_uniq
  ON trip_delay_obs (agency, trip_id, stop_sequence, service_date)
  WHERE stop_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delay_obs_method ON trip_delay_obs (agency, method, confidence);

-- Distinct-trip count behind each bucket, so the evidence panel can say "N observations
-- across M distinct trips" instead of N observations that might all be one very late bus.
ALTER TABLE agg_delay ADD COLUMN IF NOT EXISTS n_trips INTEGER;

ALTER TABLE agg_delay_route ADD COLUMN IF NOT EXISTS n_trips INTEGER;
