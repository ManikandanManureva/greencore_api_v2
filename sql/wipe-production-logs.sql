-- ════════════════════════════════════════════════════════════════
-- wipe-production-logs.sql
--
-- Removes ALL production data so the dashboard's "stock = received −
-- processed" math is no longer poisoned by legacy production_logs
-- entries that claim more was processed than ever entered the gate.
--
-- This wipes:
--   • production_logs      (per-bag scan records)
--   • operator_shifts      (the closed/active shift sessions)
--   • by_products          (cascaded — depends on operator_shifts)
--   • anything else with a FK to operator_shifts (cascaded)
--
-- KEEPS:
--   • users, stations, material_types, shift_types, material_flow_stations,
--     ppic_assignments, audit_logs, etc.
--
-- After this:
--   • Inventory dashboard Stock will equal Gate-received (PC/PE/PET
--     legitimate values, no more clamping at 0).
--   • Production Logs page and Overview will be empty until new shifts
--     are recorded by operators (or you re-seed).
--
-- Run against greencorev2:
--   psql greencorev2 -f sql/wipe-production-logs.sql
-- ════════════════════════════════════════════════════════════════

BEGIN;

SELECT 'BEFORE — production_logs rows:' AS info, COUNT(*) AS rows FROM production_logs;
SELECT 'BEFORE — operator_shifts rows:' AS info, COUNT(*) AS rows FROM operator_shifts;

-- CASCADE will also empty by_products and any other tables that
-- reference operator_shifts via foreign key.
TRUNCATE TABLE operator_shifts RESTART IDENTITY CASCADE;

-- production_logs is wiped by the CASCADE above; this is a belt-and-braces
-- TRUNCATE in case the FK isn't ON DELETE CASCADE on every install.
TRUNCATE TABLE production_logs RESTART IDENTITY CASCADE;

SELECT 'AFTER — production_logs rows:'  AS info, COUNT(*) AS rows FROM production_logs;
SELECT 'AFTER — operator_shifts rows:'  AS info, COUNT(*) AS rows FROM operator_shifts;

COMMIT;
