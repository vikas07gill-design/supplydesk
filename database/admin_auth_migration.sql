CREATE TABLE IF NOT EXISTS admin_sessions (
  id CHAR(36) PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  role ENUM('admin','super_admin') NOT NULL,
  admin_id VARCHAR(120) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  INDEX idx_admin_session_expiry (expires_at),
  INDEX idx_admin_session_role (role)
) ENGINE=InnoDB;
