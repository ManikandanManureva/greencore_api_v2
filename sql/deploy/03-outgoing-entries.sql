-- ════════════════════════════════════════════════════════════════
-- migrate-outgoing.sql
--
-- Creates the `outgoing_entries` table used by Inventory →
-- Outgoing & Adjustments. Append-only, one row per movement out of
-- the plant (dispatch, reject, transfer, adjustment).
--
-- Run:
--   psql greencorev2 -f sql/migrate-outgoing.sql
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS outgoing_entries (
  id           SERIAL PRIMARY KEY,
  ref          VARCHAR(30),                 -- auto-filled "O-####" after insert (trigger below)
  occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason       VARCHAR(20)  NOT NULL,
  material     VARCHAR(10)  NOT NULL,
  quantity_kg  NUMERIC(14, 2) NOT NULL,
  reference    TEXT,                        -- DN#, customer, warehouse, etc.
  notes        TEXT,
  created_by   VARCHAR(120),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (reason IN ('dispatch', 'reject', 'transfer', 'adjustment')),
  CHECK (material IN ('PC', 'PE', 'PET'))
);

CREATE INDEX IF NOT EXISTS outgoing_occurred_idx
  ON outgoing_entries (occurred_at DESC);

CREATE INDEX IF NOT EXISTS outgoing_material_idx
  ON outgoing_entries (material);

CREATE INDEX IF NOT EXISTS outgoing_reason_idx
  ON outgoing_entries (reason);

-- Trigger: when ref is not provided, set it to "O-{id}" right after insert.
CREATE OR REPLACE FUNCTION set_outgoing_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ref IS NULL OR length(trim(NEW.ref)) = 0 THEN
    NEW.ref := 'O-' || lpad(NEW.id::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outgoing_set_ref ON outgoing_entries;
CREATE TRIGGER outgoing_set_ref
  BEFORE INSERT ON outgoing_entries
  FOR EACH ROW EXECUTE FUNCTION set_outgoing_ref();
-- Note: Postgres BEFORE INSERT runs before id is assigned by SERIAL, so we
-- actually patch the ref AFTER the row is in. Switch to AFTER INSERT + UPDATE:
DROP TRIGGER outgoing_set_ref ON outgoing_entries;

CREATE OR REPLACE FUNCTION fill_outgoing_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ref IS NULL OR length(trim(NEW.ref)) = 0 THEN
    UPDATE outgoing_entries SET ref = 'O-' || lpad(NEW.id::text, 3, '0') WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outgoing_set_ref
  AFTER INSERT ON outgoing_entries
  FOR EACH ROW EXECUTE FUNCTION fill_outgoing_ref();

SELECT 'outgoing_entries ready — rows: ' || COUNT(*) AS info FROM outgoing_entries;

COMMIT;
