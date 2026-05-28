-- ════════════════════════════════════════════════════════════════
-- migrate-opening-stock.sql
--
-- Creates the `opening_stock` table used by the Inventory → Opening
-- Stock page. The table is APPEND-ONLY: every "Save opening stock"
-- click inserts a new row. The latest row for any given period IS
-- the current opening stock; older rows are the audit/history trail.
--
-- Safe to run multiple times — uses CREATE TABLE IF NOT EXISTS.
--
-- Run:
--   psql greencorev2 -f sql/migrate-opening-stock.sql
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS opening_stock (
  id           SERIAL PRIMARY KEY,
  from_date    DATE        NOT NULL,
  to_date      DATE        NOT NULL,
  pc_kg        NUMERIC(14, 2) NOT NULL DEFAULT 0,
  pe_kg        NUMERIC(14, 2) NOT NULL DEFAULT 0,
  pet_kg       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_kg     NUMERIC(14, 2) GENERATED ALWAYS AS (pc_kg + pe_kg + pet_kg) STORED,
  notes        TEXT,
  created_by   VARCHAR(120),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (to_date >= from_date),
  CHECK (pc_kg >= 0 AND pe_kg >= 0 AND pet_kg >= 0)
);

-- Common queries: "latest row covering a date" and "history for a period".
CREATE INDEX IF NOT EXISTS opening_stock_period_idx
  ON opening_stock (from_date, to_date);

CREATE INDEX IF NOT EXISTS opening_stock_created_at_idx
  ON opening_stock (created_at DESC);

COMMENT ON TABLE  opening_stock IS
  'Append-only versioned record of day-start opening stock per material. Latest row by created_at within a period = current opening.';
COMMENT ON COLUMN opening_stock.total_kg IS
  'Computed: pc_kg + pe_kg + pet_kg.';

SELECT 'opening_stock table ready — rows: ' || COUNT(*) AS info FROM opening_stock;

COMMIT;
