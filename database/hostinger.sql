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


-- ============================================================
-- SupplyDesk current launch schema additions
-- This section keeps the Hostinger/phpMyAdmin schema aligned
-- with the running Node.js application.
-- ============================================================

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

ALTER TABLE supplier_profiles ADD COLUMN profile_details_json TEXT NULL;

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

CREATE TABLE IF NOT EXISTS buyer_dashboard_tokens (
  id CHAR(36) PRIMARY KEY,
  buyer_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  last_used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_buyer_dashboard_token_buyer FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
  INDEX idx_buyer_dashboard_token_buyer (buyer_id, created_at),
  INDEX idx_buyer_dashboard_token_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS buyer_email_otps (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  otp_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  verified_at DATETIME NULL,
  verification_token_hash CHAR(64) NULL,
  verification_expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_buyer_email_otp (email, created_at),
  INDEX idx_buyer_email_otp_token (verification_token_hash)
) ENGINE=InnoDB;

-- Existing installations may already have connect_requests.
-- Add the buyer enquiry link only when it is not present.
ALTER TABLE connect_requests ADD COLUMN enquiry_id CHAR(36) NULL;
ALTER TABLE connect_requests ADD INDEX idx_connect_enquiry (enquiry_id);
ALTER TABLE connect_requests ADD CONSTRAINT fk_connect_enquiry
  FOREIGN KEY (enquiry_id) REFERENCES buyer_enquiries(id) ON DELETE SET NULL;
