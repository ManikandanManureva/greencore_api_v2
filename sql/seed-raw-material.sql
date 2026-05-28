-- ════════════════════════════════════════════════════════════════
-- seed-raw-material.sql
--
-- Inserts ~60 realistic gate-entry records spread across the last
-- 14 days, with sensible truck weights, supplier mix and material
-- distribution (PC > PE > PET).
--
-- Run AFTER wipe-raw-material.sql against the greencorev2 database:
--   psql greencorev2 -f sql/seed-raw-material.sql
--
-- Re-running this script just appends more rows — wipe first if
-- you want a clean reset.
-- ════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  d              INT;
  i              INT;
  num_entries    INT;
  mat            TEXT;
  mat_pick       NUMERIC;
  supplier_pick  TEXT;
  truck_pick     TEXT;
  entry_w        NUMERIC;
  exit_w         NUMERIC;
  net_w          NUMERIC;
  ent_date       DATE;
  ext_time       TIME;
  ref_seq        INT := 1;

  suppliers TEXT[] := ARRAY[
    'Acme Recycling Co.',
    'GreenWaste Sdn Bhd',
    'EcoCollect Trading',
    'BlueOcean Plastics',
    'City Waste Solutions',
    'Pioneer Polymers'
  ];
  trucks TEXT[] := ARRAY[
    'WA1234A','BK6789B','PN2134C','KL1112D','JH3344E',
    'SA9988F','MY4432G','NS5566H','PG7788J','TR8899K'
  ];
BEGIN
  -- 14 days back, today inclusive.
  FOR d IN 0..13 LOOP
    ent_date := CURRENT_DATE - d;
    -- 3 – 5 trucks per day
    num_entries := 3 + floor(random() * 3)::int;

    FOR i IN 1..num_entries LOOP
      -- Material distribution: PC 50% / PE 30% / PET 20%
      mat_pick := random();
      IF mat_pick < 0.50 THEN
        mat := 'PC';
        entry_w := 22000 + random() * 5000;   -- 22 – 27 t loaded
        exit_w  :=  9000 + random() * 2000;   --  9 – 11 t empty
      ELSIF mat_pick < 0.80 THEN
        mat := 'PE';
        entry_w := 18000 + random() * 4500;
        exit_w  :=  8500 + random() * 1800;
      ELSE
        mat := 'PET';
        entry_w := 14000 + random() * 4500;   -- PET is lighter / less dense
        exit_w  :=  8000 + random() * 1500;
      END IF;

      net_w := entry_w - exit_w;

      -- Random exit time between 07:00 and 18:00
      ext_time := time '07:00:00'
        + (floor(random() * 11)::int   || ' hours')::interval
        + (floor(random() * 60)::int   || ' minutes')::interval;

      supplier_pick := suppliers[1 + floor(random() * array_length(suppliers, 1))::int];
      truck_pick    := trucks   [1 + floor(random() * array_length(trucks,    1))::int];

      INSERT INTO raw_material (
        "refId",
        entrydate, entrytime,
        exitdate,  exittime,
        "truckId",
        supplier,
        plant,
        "materialType",
        "materialDescription",
        "entryWeight", "exitWeight", "netWeight",
        "deliveryNote",
        quantity,
        status,
        "createdBy", "updatedBy",
        "createdAt", "updatedAt"
      ) VALUES (
        'GE-' || to_char(ent_date, 'YYYYMMDD') || '-' || lpad(i::text, 3, '0'),
        ent_date,
        ext_time - interval '35 minutes',
        ent_date,
        ext_time,
        truck_pick,
        supplier_pick,
        'Main',
        mat,
        CASE mat
          WHEN 'PC'  THEN 'Polycarbonate flakes, mixed grade'
          WHEN 'PE'  THEN 'HDPE / LDPE mixed bales'
          WHEN 'PET' THEN 'PET bottles, post-consumer baled'
        END,
        round(entry_w),
        round(exit_w),
        round(net_w),
        'DN-' || lpad((1000 + ref_seq)::text, 5, '0'),
        floor(random() * 50 + 10)::int,
        'Accepted',
        'gate_op_seed',
        'gate_op_seed',
        ent_date + ext_time,
        ent_date + ext_time
      );
      ref_seq := ref_seq + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Seeded % gate-entry rows', ref_seq - 1;
END $$;

-- Summary report
SELECT
  "materialType"            AS material,
  COUNT(*)                  AS entries,
  round(SUM("netWeight"))   AS total_net_kg,
  round(AVG("netWeight"))   AS avg_net_kg,
  MIN(exitdate)             AS earliest,
  MAX(exitdate)             AS latest
FROM raw_material
WHERE "createdBy" = 'gate_op_seed'
GROUP BY "materialType"
ORDER BY "materialType";

COMMIT;
