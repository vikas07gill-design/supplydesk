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


CREATE TABLE IF NOT EXISTS supplier_product_files (
  id CHAR(36) PRIMARY KEY,
  product_id CHAR(36) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  relative_path VARCHAR(700) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','approved','rejected','archived') NOT NULL DEFAULT 'pending',
  admin_notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by VARCHAR(120) NULL,
  CONSTRAINT fk_supplier_product_file_product FOREIGN KEY (product_id) REFERENCES supplier_products(id) ON DELETE CASCADE,
  INDEX idx_supplier_product_file_product (product_id, status, created_at)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS buyers (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(180) NULL,
  company VARCHAR(180) NULL,
  country VARCHAR(120) NULL,
  phone VARCHAR(80) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME NULL,
  UNIQUE KEY uq_buyer_email (email),
  INDEX idx_buyer_last_seen (last_seen)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS buyer_enquiries (
  id CHAR(36) PRIMARY KEY,
  buyer_id CHAR(36) NOT NULL,
  product_id CHAR(36) NULL,
  supplier_id CHAR(36) NOT NULL,
  message TEXT NULL,
  quantity VARCHAR(120) NULL,
  status ENUM('new','contacted','in_discussion','closed') NOT NULL DEFAULT 'new',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  CONSTRAINT fk_buyer_enquiry_buyer FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
  CONSTRAINT fk_buyer_enquiry_product FOREIGN KEY (product_id) REFERENCES supplier_products(id) ON DELETE SET NULL,
  CONSTRAINT fk_buyer_enquiry_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_buyer_enquiry_buyer (buyer_id, created_at),
  INDEX idx_buyer_enquiry_supplier (supplier_id, created_at),
  INDEX idx_buyer_enquiry_product (product_id, created_at)
) ENGINE=InnoDB;
