CREATE TABLE IF NOT EXISTS supplier_dashboard_otps (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  otp_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dashboard_otp_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_dashboard_otp_supplier (supplier_id, created_at),
  INDEX idx_dashboard_otp_expiry (expires_at)
) ENGINE=InnoDB;