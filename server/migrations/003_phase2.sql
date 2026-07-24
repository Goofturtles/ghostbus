-- Phase 2: the (route, hour_of_week) delay rollup used as the Honest-ETA fallback
-- bucket when a (route, stop, hour_of_week) bucket in agg_delay is too thin (n < 8).
-- Standard Postgres SQL only (runs identically on pg and PGlite). Additive migration.

CREATE TABLE IF NOT EXISTS agg_delay_route (
  agency       TEXT NOT NULL,
  route_id     TEXT NOT NULL,
  hour_of_week SMALLINT NOT NULL,
  n            INTEGER,
  p25          INTEGER,
  p50          INTEGER,
  p75          INTEGER,
  updated      TIMESTAMPTZ,
  PRIMARY KEY (agency, route_id, hour_of_week)
);
