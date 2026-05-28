-- ════════════════════════════════════════════════════════════════
-- seed-today-receipts.sql
--
-- APPENDS ~17 realistic gate-entry receipts for CURRENT_DATE only.
-- Does NOT wipe existing data. Safe to run multiple times — each
-- run adds a fresh batch (with new ref ids).
--
-- After running, the Inventory dashboard + Receipts page will show:
--   • ~17 trucks logged today
--   • ~200 t total received today
--   • 2 entries in "Pending QC"
--   • A nice mix of PC / PE / PET
--
-- Run against greencorev2:
--   psql greencorev2 -f sql/seed-today-receipts.sql
-- ════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  -- ── 17 explicit entries spread across today, varied by material ──
  -- Each row:   (mat, entry_kg, exit_kg, hh, mm, vendor, vehicle, status)
  entries CONSTANT JSONB := '[
    { "mat":"PC",  "entry":24500, "exit":10100, "h":7,  "m":12, "vendor":"Acme Recycling Co.",      "veh":"WA1234A", "status":"Accepted" },
    { "mat":"PE",  "entry":20200, "exit": 9300, "h":7,  "m":48, "vendor":"GreenWaste Sdn Bhd",      "veh":"BK6789B", "status":"Accepted" },
    { "mat":"PC",  "entry":25700, "exit":10400, "h":8,  "m":25, "vendor":"Pioneer Polymers",        "veh":"PN2134C", "status":"Accepted" },
    { "mat":"PET", "entry":17200, "exit": 8900, "h":8,  "m":52, "vendor":"BlueOcean Plastics",      "veh":"KL1112D", "status":"Accepted" },
    { "mat":"PC",  "entry":26100, "exit":10600, "h":9,  "m":17, "vendor":"City Waste Solutions",    "veh":"JH3344E", "status":"Accepted" },
    { "mat":"PE",  "entry":19800, "exit": 9100, "h":9,  "m":44, "vendor":"EcoCollect Trading",      "veh":"SA9988F", "status":"Accepted" },
    { "mat":"PET", "entry":15300, "exit": 8400, "h":10, "m":11, "vendor":"Acme Recycling Co.",      "veh":"MY4432G", "status":"Pending"  },
    { "mat":"PC",  "entry":24900, "exit":10200, "h":10, "m":36, "vendor":"GreenWaste Sdn Bhd",      "veh":"NS5566H", "status":"Accepted" },
    { "mat":"PE",  "entry":21100, "exit": 9500, "h":11, "m": 5, "vendor":"Pioneer Polymers",        "veh":"PG7788J", "status":"Accepted" },
    { "mat":"PC",  "entry":25500, "exit":10500, "h":11, "m":48, "vendor":"BlueOcean Plastics",      "veh":"TR8899K", "status":"Accepted" },
    { "mat":"PET", "entry":16800, "exit": 8700, "h":12, "m":22, "vendor":"City Waste Solutions",    "veh":"WA1234A", "status":"Accepted" },
    { "mat":"PE",  "entry":20500, "exit": 9700, "h":13, "m": 9, "vendor":"EcoCollect Trading",      "veh":"BK6789B", "status":"Pending"  },
    { "mat":"PC",  "entry":26400, "exit":10700, "h":13, "m":51, "vendor":"Acme Recycling Co.",      "veh":"PN2134C", "status":"Accepted" },
    { "mat":"PET", "entry":14500, "exit": 8200, "h":14, "m":28, "vendor":"GreenWaste Sdn Bhd",      "veh":"KL1112D", "status":"Accepted" },
    { "mat":"PC",  "entry":25200, "exit":10300, "h":15, "m":15, "vendor":"Pioneer Polymers",        "veh":"JH3344E", "status":"Accepted" },
    { "mat":"PE",  "entry":19400, "exit": 9000, "h":16, "m": 3, "vendor":"BlueOcean Plastics",      "veh":"SA9988F", "status":"Accepted" },
    { "mat":"PC",  "entry":25900, "exit":10400, "h":17, "m":42, "vendor":"City Waste Solutions",    "veh":"MY4432G", "status":"Accepted" }
  ]'::jsonb;

  rec        JSONB;
  ent_w      NUMERIC;
  exit_w     NUMERIC;
  net_w      NUMERIC;
  ext_time   TIME;
  ref_seq    INT := 0;
  start_id   INT;
BEGIN
  -- Sequential GE# suffix continues from current row count for the day so
  -- repeated runs don't collide on ref numbers.
  SELECT COALESCE(MAX(
           NULLIF(regexp_replace(
             COALESCE("refId",''),
             '^GE-' || to_char(CURRENT_DATE,'YYYYMMDD') || '-(\d+)$', '\1'
           ), '')::int
         ), 0) INTO start_id
    FROM raw_material
    WHERE exitdate = CURRENT_DATE;

  FOR rec IN SELECT * FROM jsonb_array_elements(entries) LOOP
    ref_seq := ref_seq + 1;
    ent_w   := (rec->>'entry')::numeric;
    exit_w  := (rec->>'exit')::numeric;
    net_w   := ent_w - exit_w;
    ext_time := make_time((rec->>'h')::int, (rec->>'m')::int, 0);

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
      'GE-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || lpad((start_id + ref_seq)::text, 3, '0'),
      CURRENT_DATE,
      ext_time - interval '35 minutes',
      CURRENT_DATE,
      ext_time,
      rec->>'veh',
      rec->>'vendor',
      'Main',
      rec->>'mat',
      CASE rec->>'mat'
        WHEN 'PC'  THEN 'Polycarbonate flakes, mixed grade'
        WHEN 'PE'  THEN 'HDPE / LDPE mixed bales'
        WHEN 'PET' THEN 'PET bottles, post-consumer baled'
      END,
      round(ent_w),
      round(exit_w),
      round(net_w),
      'DN-' || lpad((start_id + ref_seq + 2000)::text, 5, '0'),
      floor(random() * 50 + 10)::int,
      rec->>'status',
      'gate_op_today',
      'gate_op_today',
      CURRENT_DATE + ext_time,
      CURRENT_DATE + ext_time
    );
  END LOOP;

  RAISE NOTICE 'Inserted % gate entries for today (%)', ref_seq, CURRENT_DATE;
END $$;

-- Summary report
SELECT
  "materialType"                             AS material,
  COUNT(*)                                   AS entries,
  round(SUM("netWeight"))                    AS total_net_kg,
  COUNT(*) FILTER (WHERE status = 'Pending') AS pending_qc
FROM raw_material
WHERE exitdate = CURRENT_DATE
GROUP BY "materialType"
ORDER BY "materialType";

SELECT
  COUNT(*)                                   AS today_entries,
  round(SUM("netWeight"))                    AS today_total_net_kg,
  COUNT(*) FILTER (WHERE status = 'Pending') AS today_pending_qc
FROM raw_material
WHERE exitdate = CURRENT_DATE;

COMMIT;
