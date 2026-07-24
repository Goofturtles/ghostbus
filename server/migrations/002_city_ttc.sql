-- Baseline city row so `ttc` always exists (collector may run before the first seed).
-- The bounding box is intentionally left NULL here; seed:toronto fills it from real
-- stop coordinates so the box is never a guessed/fabricated constant.

INSERT INTO cities (agency, name, tz)
VALUES ('ttc', 'Toronto TTC', 'America/Toronto')
ON CONFLICT (agency) DO NOTHING;
