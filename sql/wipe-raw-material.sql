-- ════════════════════════════════════════════════════════════════
-- wipe-raw-material.sql
--
-- Removes ALL gate-entry records from raw_material and resets the
-- id sequence back to 1. Use this to start clean before seeding or
-- before letting the gate-entry feature record live data.
--
-- Run against the greencorev2 database:
--   psql greencorev2 -f sql/wipe-raw-material.sql
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- Report current row count before wiping (visible in psql).
SELECT 'BEFORE wipe — raw_material rows:' AS info, COUNT(*) AS rows FROM raw_material;

TRUNCATE TABLE raw_material RESTART IDENTITY;

SELECT 'AFTER wipe — raw_material rows:' AS info, COUNT(*) AS rows FROM raw_material;

COMMIT;
