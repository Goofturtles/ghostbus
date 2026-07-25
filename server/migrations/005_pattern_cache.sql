-- Phase 7: stop paying 2.15M stop_times rows for every process boot.
--
-- buildPatternIndex reads every stop_times row (measured 109-120 s over Neon) and it ran
-- on every boot and again every 6 hours. Four rebuilds inside one measurement session
-- exhausted the Neon free-tier data-transfer quota and took the collector down. On Render
-- free tier, which sleeps after 15 minutes of inactivity, every wake is a fresh boot, so
-- that cost would recur continuously and the deployment would simply stop working.
--
-- This table holds the built index as one compressed blob so a boot restores it instead.
-- The row is keyed by agency (one live board per agency) and carries the board tag AND a
-- content fingerprint of the static tables the index is derived from. The reader matches
-- on both in the WHERE clause, so a cache that no longer describes the current board
-- returns ZERO ROWS and costs no transfer at all -- the check is never a download.
--
-- payload is base64 TEXT rather than BYTEA on purpose: node-postgres reads results in the
-- text format, where a bytea comes back hex-encoded at 2.00x the payload size, while
-- base64 costs 1.33x. The blob itself is gzipped before encoding, and sha256 lets a
-- truncated or corrupted payload be rejected rather than half-loaded.
--
-- Additive only. Standard Postgres SQL, so it runs identically on pg (Neon) and PGlite.
-- Keep one statement per semicolon and no semicolons inside string literals -- the
-- migration runner splits on top-level semicolons.

CREATE TABLE IF NOT EXISTS pattern_index_cache (
  agency      TEXT PRIMARY KEY,
  board_tag   TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  format      INTEGER NOT NULL,
  -- bytes and sha256 both describe the SEALED BINARY blob (magic + format + digest +
  -- gzip), not the base64 armour it is stored in. A reader base64-decodes payload_b64 and
  -- checks the result against both, so a truncated or re-encoded row is rejected whole.
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  payload_b64 TEXT NOT NULL,
  patterns    INTEGER NOT NULL,
  slots       INTEGER NOT NULL,
  built_at_ms BIGINT NOT NULL,
  build_ms    INTEGER NOT NULL,
  updated     TIMESTAMPTZ NOT NULL DEFAULT now()
);
