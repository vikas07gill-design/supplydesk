CREATE DATABASE IF NOT EXISTS supplydesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE supplydesk;

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
  profile_details_json TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_profile_application
    FOREIGN KEY (application_id) REFERENCES supplier_applications(id) ON DELETE CASCADE,
  INDEX idx_profile_public (published, verified),
  INDEX idx_profile_category (category, subcategory),
  INDEX idx_profile_location (country, city)
) ENGINE=InnoDB;


-- ============================================================
-- Current launch additions. See database/hostinger.sql for the
-- phpMyAdmin deployment copy.
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
  monthly_capacity BIGINT UNSIGNED NULL,
  available_capacity BIGINT UNSIGNED NULL,
  capacity_unit VARCHAR(40) NULL,
  lead_time_days SMALLINT UNSIGNED NULL,
  origin_region VARCHAR(150) NULL,
  capacity_updated_at DATETIME NULL,
  capability_code VARCHAR(24) NULL,
  UNIQUE KEY uq_capability_code (capability_code),
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
  decision ENUM('pending','accepted','partial','rejected') NOT NULL DEFAULT 'pending',
  approved_quantity VARCHAR(120) NULL,
  buyer_remark TEXT NULL,
  decided_at DATETIME NULL,
  decided_by VARCHAR(120) NULL,
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

ALTER TABLE connect_requests ADD COLUMN enquiry_id CHAR(36) NULL;
ALTER TABLE connect_requests ADD INDEX idx_connect_enquiry (enquiry_id);
ALTER TABLE connect_requests ADD CONSTRAINT fk_connect_enquiry
  FOREIGN KEY (enquiry_id) REFERENCES buyer_enquiries(id) ON DELETE SET NULL;


-- Buyer requirement / RFQ and supplier quotation workflow
CREATE TABLE IF NOT EXISTS buyer_requirements (
  rfq_code VARCHAR(24) NULL UNIQUE,
  rfq_state VARCHAR(30) NULL,
  state_changed_at DATETIME NULL,
  specification TEXT NULL,
  quality_standards TEXT NULL,
  certifications VARCHAR(255) NULL,
  packaging TEXT NULL,
  payment_terms VARCHAR(255) NULL,
  incoterm VARCHAR(40) NULL,
  id CHAR(36) PRIMARY KEY,
  buyer_id CHAR(36) NOT NULL,
  requirement_type ENUM('product','raw_material','machinery','service','custom') NOT NULL DEFAULT 'product',
  title VARCHAR(255) NOT NULL,
  category VARCHAR(180) NULL,
  subcategory VARCHAR(180) NULL,
  description TEXT NOT NULL,
  quantity VARCHAR(120) NULL,
  unit VARCHAR(80) NULL,
  target_price DECIMAL(18,4) NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  delivery_country VARCHAR(120) NULL,
  delivery_city VARCHAR(150) NULL,
  required_by DATE NULL,
  market_scope ENUM('Domestic','International','Both') NOT NULL DEFAULT 'Both',
  status ENUM('open','closed','cancelled') NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  CONSTRAINT fk_requirement_buyer FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
  INDEX idx_requirement_buyer (buyer_id, created_at),
  INDEX idx_requirement_match (status, category, subcategory, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rfq_messages (
  id CHAR(36) PRIMARY KEY,
  rfq_id CHAR(36) NOT NULL,
  buyer_id CHAR(36) NOT NULL,
  kind VARCHAR(30) NOT NULL DEFAULT 'message',
  subject VARCHAR(255) NOT NULL,
  body TEXT NULL,
  created_by VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_rfqmsg_rfq (rfq_id, created_at),
  INDEX idx_rfqmsg_buyer (buyer_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor VARCHAR(190) NOT NULL,
  actor_role VARCHAR(40) NOT NULL,
  action VARCHAR(80) NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id VARCHAR(80) NOT NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  request_ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_entity (entity, entity_id, created_at),
  INDEX idx_audit_actor (actor, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rfq_quotes (
  id CHAR(36) PRIMARY KEY,
  rfq_id CHAR(36) NOT NULL,
  quote_no VARCHAR(24) NOT NULL UNIQUE,
  unit_price DECIMAL(14,4) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  quantity VARCHAR(60) NOT NULL,
  total_price DECIMAL(16,2) NULL,
  lead_time_days INT NULL,
  valid_until DATE NULL,
  terms TEXT NULL,
  cost_unit_price DECIMAL(14,4) NULL,
  markup_pct DECIMAL(6,2) NULL,
  note TEXT NULL,
  status ENUM('sent','accepted','rejected','superseded') NOT NULL DEFAULT 'sent',
  buyer_note VARCHAR(500) NULL,
  created_by VARCHAR(190) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  INDEX idx_rfqq_rfq (rfq_id, status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY,
  po_number VARCHAR(24) NOT NULL UNIQUE,
  rfq_id CHAR(36) NOT NULL UNIQUE,
  rfq_quote_id CHAR(36) NOT NULL,
  buyer_id CHAR(36) NOT NULL,
  title VARCHAR(255) NOT NULL,
  quantity VARCHAR(60) NOT NULL,
  unit_price DECIMAL(14,4) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  total_price DECIMAL(16,2) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
  status_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes VARCHAR(500) NULL,
  review_status VARCHAR(24) NOT NULL DEFAULT 'accepted',
  review_note VARCHAR(1500) NULL,
  reviewed_at DATETIME NULL,
  reviewed_by VARCHAR(120) NULL,
  requested_quantity VARCHAR(60) NULL,
  stage VARCHAR(30) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_orders_buyer (buyer_id, created_at),
  INDEX idx_orders_status (status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_pos (
  id CHAR(36) PRIMARY KEY,
  po_number VARCHAR(24) NOT NULL UNIQUE,
  order_id CHAR(36) NULL,
  sd_order_id CHAR(36) NULL,
  supplier_id CHAR(36) NOT NULL,
  product_id CHAR(36) NULL,
  title VARCHAR(255) NOT NULL,
  quantity VARCHAR(60) NOT NULL,
  unit_cost DECIMAL(14,4) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  total_cost DECIMAL(16,2) NULL,
  delivery_by DATE NULL,
  terms TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'issued',
  supplier_note VARCHAR(500) NULL,
  accepted_quantity VARCHAR(60) NULL,
  batch_no VARCHAR(60) NULL,
  production_started_at DATETIME NULL,
  expected_completion DATE NULL,
  status_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(190) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_spo_supplier (supplier_id, status, created_at),
  INDEX idx_spo_order (order_id, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sd_orders (
  id CHAR(36) PRIMARY KEY,
  sd_number VARCHAR(24) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  note VARCHAR(1000) NULL,
  created_by VARCHAR(190) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sd_order_items (
  id CHAR(36) PRIMARY KEY,
  sd_order_id CHAR(36) NOT NULL,
  buyer_order_id CHAR(36) NOT NULL UNIQUE,
  quantity DECIMAL(16,2) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sdi_sd (sd_order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_po_lines (
  id CHAR(36) PRIMARY KEY,
  supplier_po_id CHAR(36) NOT NULL,
  sd_order_id CHAR(36) NOT NULL,
  buyer_order_id CHAR(36) NOT NULL,
  quantity DECIMAL(16,2) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spl (supplier_po_id, buyer_order_id),
  INDEX idx_spl_buyer (buyer_order_id),
  INDEX idx_spl_sd (sd_order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  stage VARCHAR(30) NULL,
  ref VARCHAR(120) NULL,
  detail VARCHAR(1000) NULL,
  created_by VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_oe_order (order_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invoices (
  id CHAR(36) PRIMARY KEY,
  invoice_no VARCHAR(24) NOT NULL UNIQUE,
  order_id CHAR(36) NOT NULL,
  buyer_id CHAR(36) NOT NULL,
  subtotal DECIMAL(16,2) NOT NULL,
  gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
  total DECIMAL(16,2) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  due_date DATE NULL,
  notes VARCHAR(1000) NULL,
  status ENUM('issued','partially_paid','paid','void') NOT NULL DEFAULT 'issued',
  paid_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
  created_by VARCHAR(190) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_at DATETIME NULL,
  INDEX idx_inv_order (order_id, status),
  INDEX idx_inv_buyer (buyer_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) PRIMARY KEY,
  invoice_id CHAR(36) NOT NULL,
  amount DECIMAL(16,2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  reference VARCHAR(120) NULL,
  received_on DATE NOT NULL,
  note VARCHAR(500) NULL,
  recorded_by VARCHAR(190) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pay_invoice (invoice_id, received_on)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS requirement_supplier_matches (
  id CHAR(36) PRIMARY KEY,
  requirement_id CHAR(36) NOT NULL,
  supplier_id CHAR(36) NOT NULL,
  status ENUM('available','viewed','quoted','declined') NOT NULL DEFAULT 'available',
  viewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_requirement_supplier (requirement_id, supplier_id),
  CONSTRAINT fk_req_match_requirement FOREIGN KEY (requirement_id) REFERENCES buyer_requirements(id) ON DELETE CASCADE,
  CONSTRAINT fk_req_match_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_req_match_supplier (supplier_id, status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_quotes (
  id CHAR(36) PRIMARY KEY,
  requirement_id CHAR(36) NOT NULL,
  supplier_id CHAR(36) NOT NULL,
  unit_price DECIMAL(18,4) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  quantity_available VARCHAR(120) NULL,
  moq VARCHAR(120) NULL,
  lead_time VARCHAR(120) NULL,
  payment_terms VARCHAR(255) NULL,
  incoterm VARCHAR(40) NULL,
  quote_valid_until DATE NULL,
  sample_available TINYINT(1) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  status ENUM('submitted','withdrawn') NOT NULL DEFAULT 'submitted',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  UNIQUE KEY uq_supplier_quote (requirement_id, supplier_id),
  CONSTRAINT fk_quote_requirement FOREIGN KEY (requirement_id) REFERENCES buyer_requirements(id) ON DELETE CASCADE,
  CONSTRAINT fk_quote_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
  INDEX idx_quote_requirement (requirement_id, status, created_at),
  INDEX idx_quote_supplier (supplier_id, created_at)
) ENGINE=InnoDB;
