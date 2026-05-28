-- ════════════════════════════════════════════════════════════════
-- seed-users.sql — populate both `user` (gate-entry) and `users`
-- (greencore_api_v2 dashboard) tables with the production user list.
--
-- For `user`: SHA256 password hashes preserved from production dump.
-- For `users`: bcrypt hash of "password123" (override by running
--             create-*-user.js scripts after this seed).
-- ════════════════════════════════════════════════════════════════
BEGIN;

-- 1. user table (greencode_api)
TRUNCATE TABLE "user" RESTART IDENTITY;
INSERT INTO "user" ("id","userName","password","firstName","lastName","emailId","isActive","createdBy","updatedBy","createdAt","updatedAt","employeeId","phoneNumber","shiftAssigned","mustChangePassword","deactivatedAt","deactivatedBy","deactivationReason","deactivationNotes","failedLoginAttempts","lockedAt","role") VALUES
  (4,'admin','240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9','Admin','User','admin@greencore.com',1,'system','system','2025-11-28 13:55:15','2026-01-11 11:30:38','ADMIN',NULL,'1',1,NULL,NULL,NULL,NULL,0,NULL,'Admin'),
  (23,'MANI','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','Manikandan','','admin1@greencore.com',1,'system','system','2026-01-11 11:31:47','2026-02-04 17:23:21','MANI',NULL,'1',1,NULL,NULL,NULL,NULL,2,NULL,'Admin'),
  (24,'PC_LABEL_REMOVAL','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pc_label_removal','','pc_label_removal@user.com',1,'system','system','2026-01-11 18:09:20','2026-01-11 18:09:20','PC_LABEL_REMOVAL','+6211111111111','2',1,NULL,NULL,NULL,NULL,0,NULL,'PC'),
  (25,'PC_CRUSHER','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pc_crusher','','pc_crusher@user.com',1,'system','system','2026-01-11 18:22:57','2026-01-15 12:10:00','PC_CRUSHER','+628123456789','1',1,NULL,NULL,NULL,NULL,0,NULL,'PC'),
  (26,'PC_WASHING','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pc_washing','','pc_washing@user.com',1,'system','system','2026-01-11 19:26:24','2026-01-11 19:26:24','PC_WASHING','+628123456789','1',1,NULL,NULL,NULL,NULL,0,NULL,'PC'),
  (27,'PC_EXTRUSION','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pc_extrusion','','pc_extrusion@user.com',1,'system','system','2026-01-11 19:26:52','2026-01-11 19:26:52','PC_EXTRUSION','+628123456789','1',1,NULL,NULL,NULL,NULL,0,NULL,'PC'),
  (28,'PC_FINAL_PACKING','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pc_final_packing','','pc_final_packing@user.com',1,'system','system','2026-01-11 19:27:46','2026-01-11 19:27:46','PC_FINAL_PACKING','+628123456789','2',1,NULL,NULL,NULL,NULL,0,NULL,'PC'),
  (29,'PE_CRUSHER','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pe_crusher','','pe_crusher@user.com',1,'system','system','2026-01-11 19:28:14','2026-01-11 19:28:14','PE_CRUSHER','+628123456789','1',1,NULL,NULL,NULL,NULL,0,NULL,'PE'),
  (30,'PE_WASHING','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pe_washing','','pe_washing@user.com',1,'system','system','2026-01-11 19:28:41','2026-01-11 19:28:41','PE_WASHING','+628123456789','1',1,NULL,NULL,NULL,NULL,0,NULL,'PE'),
  (31,'PE_DRYING','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pe_drying','','pe_drying@user.com',1,'system','system','2026-01-11 19:29:07','2026-01-11 19:29:07','PE_DRYING','+628123456789','2',1,NULL,NULL,NULL,NULL,0,NULL,'PE'),
  (32,'PE_EXTRUSION','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pe_extrusion','','pe_extrusion@user.com',1,'system','system','2026-01-11 19:29:32','2026-01-11 19:29:32','PE_EXTRUSION','+628123456789','2',1,NULL,NULL,NULL,NULL,0,NULL,'PE'),
  (33,'PET_LABEL_REMOVAL','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pet_label_removal','','pet_label_removal@user.com',1,'system','system','2026-01-11 19:29:56','2026-01-11 19:29:56','PET_LABEL_REMOVAL','+628123456789','2',1,NULL,NULL,NULL,NULL,0,NULL,'PET'),
  (34,'PET_CRUSHER','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pet_crusher','','pet_crusher@user.com',1,'system','system','2026-01-11 19:30:23','2026-01-11 19:30:23','PET_CRUSHER','+628123456789','2',1,NULL,NULL,NULL,NULL,0,NULL,'PET'),
  (35,'PET_WASHING','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pet_washing','','pet_washing@user.com',1,'system','system','2026-01-11 19:30:48','2026-01-11 19:30:48','PET_WASHING','+628123456789','1',1,NULL,NULL,NULL,NULL,0,NULL,'PET'),
  (36,'PET_BORRETEC_SIZING_OPERATOR','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pet_borretec_sizing_operator','','pet_borretec_sizing_operator@greencore.com',1,'system','system','2026-01-11 19:31:26','2026-01-11 19:31:26','PET_BORRETEC_SIZING_OPERATOR','+628123456789','2',1,NULL,NULL,NULL,NULL,0,NULL,'PET'),
  (37,'PET_FLAKE','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pet_flake','','pet_flake@user.com',1,'system','system','2026-01-11 19:31:58','2026-01-11 19:31:58','PET_FLAKE','+6211111111111','2',1,NULL,NULL,NULL,NULL,0,NULL,'PET'),
  (38,'PET_STARLINGER_EXTRUSION_OPERATOR','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','pet_starlinger_extrusion_operator','','pet_starlinger_extrusion_operator@greencore.com',1,'system','system','2026-01-11 19:32:20','2026-01-11 19:32:20','PET_STARLINGER_EXTRUSION_OPERATOR','+628123456789','2',1,NULL,NULL,NULL,NULL,0,NULL,'PET'),
  (39,'YOGA','e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7','YOGA','','yoga@gmail.com',1,'system','system','2026-01-11 11:31:47','2026-05-24 17:53:54','YOGA','+628123456789','1',1,NULL,NULL,NULL,NULL,3,NULL,'Admin');

SELECT setval(pg_get_serial_sequence('"user"','id'),
       COALESCE((SELECT MAX(id) FROM "user"), 1));

-- 2. users table (greencore_api_v2)
INSERT INTO users (employee_id, password, name, email, role, is_active) VALUES
  ('ADMIN', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'Admin User', 'admin@greencore.com', 'Admin', true),
  ('MANI', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'Manikandan', 'admin1@greencore.com', 'Admin', true),
  ('PC_LABEL_REMOVAL', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pc_label_removal', 'pc_label_removal@user.com', 'PC', true),
  ('PC_CRUSHER', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pc_crusher', 'pc_crusher@user.com', 'PC', true),
  ('PC_WASHING', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pc_washing', 'pc_washing@user.com', 'PC', true),
  ('PC_EXTRUSION', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pc_extrusion', 'pc_extrusion@user.com', 'PC', true),
  ('PC_FINAL_PACKING', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pc_final_packing', 'pc_final_packing@user.com', 'PC', true),
  ('PE_CRUSHER', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pe_crusher', 'pe_crusher@user.com', 'PE', true),
  ('PE_WASHING', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pe_washing', 'pe_washing@user.com', 'PE', true),
  ('PE_DRYING', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pe_drying', 'pe_drying@user.com', 'PE', true),
  ('PE_EXTRUSION', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pe_extrusion', 'pe_extrusion@user.com', 'PE', true),
  ('PET_LABEL_REMOVAL', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pet_label_removal', 'pet_label_removal@user.com', 'PET', true),
  ('PET_CRUSHER', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pet_crusher', 'pet_crusher@user.com', 'PET', true),
  ('PET_WASHING', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pet_washing', 'pet_washing@user.com', 'PET', true),
  ('PET_BORRETEC_SIZING_OPERATOR', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pet_borretec_sizing_operator', 'pet_borretec_sizing_operator@greencore.com', 'PET', true),
  ('PET_FLAKE', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pet_flake', 'pet_flake@user.com', 'PET', true),
  ('PET_STARLINGER_EXTRUSION_OPERATOR', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'pet_starlinger_extrusion_operator', 'pet_starlinger_extrusion_operator@greencore.com', 'PET', true),
  ('YOGA', '$2b$10$tya.TpNlL8Cq84EAJqpP/e8KI9Rj7RiKVdlVhRx6lAsL/2tHBOS/O', 'YOGA', 'yoga@gmail.com', 'Admin', true)
ON CONFLICT (employee_id) DO UPDATE
SET password = EXCLUDED.password,
    name     = EXCLUDED.name,
    role     = EXCLUDED.role,
    is_active = EXCLUDED.is_active;

COMMIT;

SELECT 'user'  AS table_name, COUNT(*) AS rows FROM "user"
UNION ALL
SELECT 'users', COUNT(*) FROM users;
