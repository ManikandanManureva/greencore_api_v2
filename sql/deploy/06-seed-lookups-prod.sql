-- ════════════════════════════════════════════════════════════════
-- 06-seed-lookups-prod.sql — seed only lookup data for prod.
--
-- Seeds:
--   role                       (6 rows)   — independent, always safe
--   module_stations            (15 rows)  — independent, always safe
--   user_station_assignments   (16 rows)  — REQUIRES user.id rows
--                                4, 23-39 to exist first (FK constraint)
--
-- Uses ON CONFLICT DO NOTHING so re-running is safe and never
-- overwrites existing prod rows. No TRUNCATE.
-- ════════════════════════════════════════════════════════════════
BEGIN;

-- role: 6 rows
INSERT INTO "role" ("id","Name","isActive","createdBy","updatedBy","createdAt","updatedAt") VALUES
  (1,'admin',1,'system','system','2025-11-28 13:55:02','2025-11-28 13:55:02'),
  (2,'basic module',1,'system','system','2025-11-28 13:55:02','2025-11-28 13:55:02'),
  (3,'station operator',1,'system','system','2025-11-28 13:55:02','2025-11-28 13:55:02'),
  (4,'pc operator',1,'system','system','2025-12-11 18:37:58','2025-12-11 18:37:58'),
  (5,'pe operator',1,'system','system','2025-12-11 18:37:58','2025-12-11 18:37:58'),
  (6,'pet operator',1,'system','system','2025-12-24 18:04:42','2025-12-24 18:04:42')
ON CONFLICT ("id") DO NOTHING;
SELECT setval(pg_get_serial_sequence('"role"','id'),
       COALESCE((SELECT MAX("id") FROM "role"), 1));

-- module_stations: 15 rows
INSERT INTO "module_stations" ("module_code","station_code","station_display_name","station_sequence","is_active") VALUES
  ('PC','CRUSHER','Crusher',2,1),
  ('PC','EXTRUSION','Extrusion',4,1),
  ('PC','FINAL_PACKAGING','Final Packaging',5,1),
  ('PC','LABEL_REMOVAL','Label Removal',1,1),
  ('PC','WASHING','Washing',3,1),
  ('PE','CRUSHER','Crusher',1,1),
  ('PE','DRYING','Drying',3,1),
  ('PE','EXTRUSION','Extrusion',4,1),
  ('PE','WASHING','Washing',2,1),
  ('PET','BORRETEC_SIZING','Borretec Sizing Station',4,1),
  ('PET','CRUSHER','Crusher Station',2,1),
  ('PET','FLAKE_SORTING','Flake Sorting Station',5,1),
  ('PET','LABEL_REMOVAL','Label Removal Station',1,1),
  ('PET','STARLINGER_EXTRUSION','Starlinger Extrusion',6,1),
  ('PET','WASHING','Washing Station',3,1)
ON CONFLICT (module_code) DO NOTHING;

-- user_station_assignments: 16 rows
INSERT INTO "user_station_assignments" ("assignment_id","user_id","module_code","station_code","assigned_at","assigned_by","is_active","deactivated_at","deactivated_by") VALUES
  (1,23,'PC','LABEL_REMOVAL','2026-01-11 11:31:47','system',1,NULL,NULL),
  (2,24,'PC','LABEL_REMOVAL','2026-01-11 18:09:20','system',1,NULL,NULL),
  (3,25,'PC','CRUSHER','2026-01-11 18:22:57','system',1,NULL,NULL),
  (4,26,'PC','WASHING','2026-01-11 19:26:24','system',1,NULL,NULL),
  (5,27,'PC','EXTRUSION','2026-01-11 19:26:52','system',1,NULL,NULL),
  (6,28,'PC','FINAL_PACKAGING','2026-01-11 19:27:46','system',1,NULL,NULL),
  (7,29,'PE','CRUSHER','2026-01-11 19:28:14','system',1,NULL,NULL),
  (8,30,'PE','WASHING','2026-01-11 19:28:41','system',1,NULL,NULL),
  (9,31,'PE','DRYING','2026-01-11 19:29:07','system',1,NULL,NULL),
  (10,32,'PE','EXTRUSION','2026-01-11 19:29:32','system',1,NULL,NULL),
  (11,33,'PET','LABEL_REMOVAL','2026-01-11 19:29:56','system',1,NULL,NULL),
  (12,34,'PET','CRUSHER','2026-01-11 19:30:23','system',1,NULL,NULL),
  (13,35,'PET','WASHING','2026-01-11 19:30:48','system',1,NULL,NULL),
  (14,36,'PET','BORRETEC_SIZING','2026-01-11 19:31:26','system',1,NULL,NULL),
  (15,37,'PET','FLAKE_SORTING','2026-01-11 19:31:58','system',1,NULL,NULL),
  (16,38,'PET','STARLINGER_EXTRUSION','2026-01-11 19:32:20','system',1,NULL,NULL)
ON CONFLICT (user_id, module_code, station_code) DO NOTHING;
SELECT setval(pg_get_serial_sequence('"user_station_assignments"','assignment_id'),
       COALESCE((SELECT MAX("assignment_id") FROM "user_station_assignments"), 1));

COMMIT;

SELECT 'role'                     AS tbl, COUNT(*) AS rows FROM "role"
UNION ALL SELECT 'module_stations',           COUNT(*) FROM module_stations
UNION ALL SELECT 'user_station_assignments',  COUNT(*) FROM user_station_assignments;
