CREATE TABLE IF NOT EXISTS supplier_update_tokens (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_update_token_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_update_token_supplier (supplier_id, created_at),
  INDEX idx_update_token_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_update_requests (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  status ENUM('pending','approved','query','rejected') NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  admin_notes TEXT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by VARCHAR(120) NULL,
  CONSTRAINT fk_update_request_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_update_request_status (status, submitted_at),
  INDEX idx_update_request_supplier (supplier_id, submitted_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_update_files (
  id CHAR(36) PRIMARY KEY,
  update_id CHAR(36) NOT NULL,
  file_type ENUM('business_registration','tax_registration','licence_certificate','address_proof','business_photo') NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  relative_path VARCHAR(700) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_update_files_request FOREIGN KEY (update_id) REFERENCES supplier_update_requests(id) ON DELETE CASCADE,
  INDEX idx_update_files_request (update_id)
) ENGINE=InnoDB;