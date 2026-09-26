CREATE TABLE IF NOT EXISTS supplier_applications (
  id CHAR(36) PRIMARY KEY,
  legal_name VARCHAR(255) NOT NULL,
  trade_name VARCHAR(255) NULL,
  business_type VARCHAR(100) NOT NULL,
  year_established SMALLINT NULL,
  country VARCHAR(100) NOT NULL,
  city VARCHAR(150) NOT NULL,
  address TEXT NOT NULL,
  business_email VARCHAR(255) NOT NULL,
  business_phone VARCHAR(80) NOT NULL,
  contact_person VARCHAR(180) NOT NULL,
  designation VARCHAR(150) NULL,
  registration_number VARCHAR(180) NULL,
  tax_number VARCHAR(180) NULL,
  import_export_number VARCHAR(180) NULL,
  website VARCHAR(500) NULL,
  certification_details TEXT NULL,
  category VARCHAR(180) NOT NULL,
  subcategory VARCHAR(180) NOT NULL,
  requested_category TEXT NULL,
  status ENUM('submitted','under_review','query','approved','rejected','suspended') NOT NULL DEFAULT 'submitted',
  admin_notes TEXT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_supplier_status (status),
  INDEX idx_supplier_location (country, city),
  INDEX idx_supplier_category (category, subcategory),
  INDEX idx_supplier_email (business_email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_files (
  id CHAR(36) PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  file_type ENUM('business_registration','tax_registration','licence_certificate','address_proof','business_photo') NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  relative_path VARCHAR(700) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_supplier_files_application
    FOREIGN KEY (application_id) REFERENCES supplier_applications(id) ON DELETE CASCADE,
  INDEX idx_files_application (application_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_verification (
  application_id CHAR(36) PRIMARY KEY,
  registration_checked TINYINT(1) NOT NULL DEFAULT 0,
  documents_checked TINYINT(1) NOT NULL DEFAULT 0,
  photos_checked TINYINT(1) NOT NULL DEFAULT 0,
  address_checked TINYINT(1) NOT NULL DEFAULT 0,
  verification_notes TEXT NULL,
  verified_at DATETIME NULL,
  verified_by VARCHAR(120) NULL,
  CONSTRAINT fk_verification_application
    FOREIGN KEY (application_id) REFERENCES supplier_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_profiles (
  id CHAR(36) PRIMARY KEY,
  application_id CHAR(36) NOT NULL UNIQUE,
  legal_name VARCHAR(255) NOT NULL,
  trade_name VARCHAR(255) NULL,
  business_type VARCHAR(100) NOT NULL,
  country VARCHAR(100) NOT NULL,
  city VARCHAR(150) NOT NULL,
  address TEXT NULL,
  website VARCHAR(500) NULL,
  business_email VARCHAR(255) NULL,
  business_phone VARCHAR(80) NULL,
  contact_person VARCHAR(180) NULL,
  designation VARCHAR(150) NULL,
  category VARCHAR(180) NOT NULL,
  subcategory VARCHAR(180) NOT NULL,
  verified TINYINT(1) NOT NULL DEFAULT 0,
  published TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_profile_application
    FOREIGN KEY (application_id) REFERENCES supplier_applications(id) ON DELETE CASCADE,
  INDEX idx_profile_public (published, verified),
  INDEX idx_profile_category (category, subcategory),
  INDEX idx_profile_location (country, city)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS connect_requests (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  customer_name VARCHAR(180) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(80) NULL,
  product_name VARCHAR(255) NULL,
  source_action ENUM('phone','email','contact') NOT NULL DEFAULT 'contact',
  message TEXT NULL,
  status ENUM('new','contacted','in_discussion','closed') NOT NULL DEFAULT 'new',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_connect_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_connect_supplier (supplier_id, created_at),
  INDEX idx_connect_customer (customer_email, created_at),
  INDEX idx_connect_status (status, created_at)
) ENGINE=InnoDB;


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
