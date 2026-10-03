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

-- Approval-controlled disclosure of the other side's identity
CREATE TABLE IF NOT EXISTS disclosure_requests (
  id CHAR(36) PRIMARY KEY,
  requested_by VARCHAR(120) NOT NULL,
  requester_role VARCHAR(30) NOT NULL,
  entity_type ENUM('requirement','sd_order') NOT NULL,
  entity_id CHAR(36) NOT NULL,
  kind ENUM('buyer_contact','supplier_identity') NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  decided_by VARCHAR(120) NULL,
  decision_note VARCHAR(500) NULL,
  decided_at DATETIME NULL,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_disc_status (status, created_at),
  INDEX idx_disc_user (requested_by, status)
) ENGINE=InnoDB;
