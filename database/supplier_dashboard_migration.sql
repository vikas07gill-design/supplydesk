CREATE TABLE IF NOT EXISTS supplier_dashboard_tokens (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  last_used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dashboard_token_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_dashboard_token_supplier (supplier_id, created_at),
  INDEX idx_dashboard_token_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_products (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  category VARCHAR(180) NOT NULL,
  subcategory VARCHAR(180) NOT NULL,
  description TEXT NULL,
  moq VARCHAR(120) NULL,
  unit VARCHAR(80) NULL,
  market_scope ENUM('Domestic','International','Both') NOT NULL DEFAULT 'Both',
  status ENUM('pending','approved','rejected','archived') NOT NULL DEFAULT 'pending',
  admin_notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by VARCHAR(120) NULL,
  CONSTRAINT fk_supplier_product_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_supplier_product_supplier (supplier_id, status, updated_at),
  INDEX idx_supplier_product_public (status, category, subcategory)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_profile_views (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  visitor_hash CHAR(64) NOT NULL,
  viewed_on DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_supplier_view_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  UNIQUE KEY uq_supplier_view_day (supplier_id, visitor_hash, viewed_on),
  INDEX idx_supplier_view_supplier (supplier_id, created_at)
) ENGINE=InnoDB;
