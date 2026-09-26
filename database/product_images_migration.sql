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
  INDEX idx_product_file_product (product_id, status, created_at),
  INDEX idx_product_file_public (status, product_id)
) ENGINE=InnoDB;
