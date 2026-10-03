-- Roles and desk assignment (also applied automatically on server start)
ALTER TABLE admin_sessions MODIFY role ENUM('admin','super_admin','tester','buyer_desk','procurement','finance','management') NOT NULL;
ALTER TABLE admin_users MODIFY role ENUM('admin','tester','buyer_desk','procurement','finance','management') NOT NULL DEFAULT 'admin';
CREATE TABLE IF NOT EXISTS employee_assignments (
  id CHAR(36) PRIMARY KEY,
  entity_type ENUM('requirement','sd_order') NOT NULL,
  entity_id CHAR(36) NOT NULL,
  desk ENUM('buyer','procurement') NOT NULL,
  admin_id VARCHAR(120) NOT NULL,
  assigned_by VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_assign (entity_type, entity_id, desk),
  INDEX idx_assign_admin (admin_id, desk, entity_type)
) ENGINE=InnoDB;
