-- Core flow + simplified onboarding. NOTE: server.js applies this automatically (idempotent) on startup;
-- this file is only for manual phpMyAdmin runs. ALTER ... ADD COLUMN errors with "duplicate column" if already applied - safe to skip.
ALTER TABLE buyers ADD COLUMN email_verified_at DATETIME NULL;
ALTER TABLE supplier_profiles ADD COLUMN onboarding_status VARCHAR(40) NOT NULL DEFAULT 'account_verified';
ALTER TABLE supplier_profiles ADD COLUMN email_verified_at DATETIME NULL;
ALTER TABLE supplier_profiles ADD COLUMN agreement_signed_at DATETIME NULL;
ALTER TABLE supplier_profiles ADD COLUMN wizard_json MEDIUMTEXT NULL;
ALTER TABLE supplier_profiles ADD COLUMN status_note VARCHAR(1500) NULL;
ALTER TABLE supplier_profiles ADD COLUMN status_updated_at DATETIME NULL;
ALTER TABLE supplier_profiles ADD COLUMN status_updated_by VARCHAR(120) NULL;
ALTER TABLE supplier_products ADD COLUMN product_verified TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN capacity_verified TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN capacity_verified_at DATETIME NULL;
ALTER TABLE supplier_products ADD COLUMN allocated_capacity BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN committed_capacity BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE supplier_files MODIFY file_type ENUM('business_registration','tax_registration','licence_certificate','address_proof','business_photo','certification','factory_photo') NOT NULL;
CREATE TABLE IF NOT EXISTS supplier_signup_otps (
  id CHAR(36) PRIMARY KEY, email VARCHAR(255) NOT NULL, otp_hash CHAR(64) NOT NULL, payload_json TEXT NOT NULL,
  expires_at DATETIME NOT NULL, attempts TINYINT UNSIGNED NOT NULL DEFAULT 0, used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_signup_email (email)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS supplier_onboarding_events (
  id CHAR(36) PRIMARY KEY, supplier_id CHAR(36) NOT NULL, from_status VARCHAR(40) NULL, to_status VARCHAR(40) NOT NULL,
  note VARCHAR(1500) NULL, actor VARCHAR(160) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_onb_supplier (supplier_id, created_at)
) ENGINE=InnoDB;
-- Grandfather already-approved suppliers
UPDATE supplier_profiles SET onboarding_status='supplydesk_approved', agreement_signed_at=COALESCE(agreement_signed_at,created_at), email_verified_at=COALESCE(email_verified_at,created_at) WHERE verified=1 AND published=1 AND onboarding_status='account_verified';
UPDATE supplier_products SET product_verified=IF(status='approved',1,0);
UPDATE supplier_products SET capacity_verified=1, capacity_verified_at=COALESCE(capacity_updated_at,NOW()) WHERE status='approved' AND monthly_capacity IS NOT NULL AND monthly_capacity>0;

-- Admin procurement workflow (accept full/partial, sourcing plan)
ALTER TABLE buyer_requirements ADD COLUMN accept_decision VARCHAR(10) NULL;
ALTER TABLE buyer_requirements ADD COLUMN accepted_quantity VARCHAR(60) NULL;
ALTER TABLE sd_orders ADD COLUMN plan_status VARCHAR(16) NOT NULL DEFAULT 'planning';
ALTER TABLE sd_orders ADD COLUMN plan_json MEDIUMTEXT NULL;
ALTER TABLE sd_orders ADD COLUMN plan_confirmed_at DATETIME NULL;
ALTER TABLE sd_orders ADD COLUMN plan_confirmed_by VARCHAR(120) NULL;
UPDATE sd_orders s SET plan_status='confirmed', plan_confirmed_at=COALESCE(plan_confirmed_at,s.created_at) WHERE EXISTS (SELECT 1 FROM supplier_pos p WHERE p.sd_order_id=s.id AND p.status NOT IN ('declined','cancelled'));
