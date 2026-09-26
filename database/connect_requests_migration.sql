-- SupplyDesk connection request storage
-- Run this in phpMyAdmin against: u327213615_supplydesk

CREATE TABLE IF NOT EXISTS connect_requests (
  id CHAR(36) PRIMARY KEY,
  supplier_id CHAR(36) NOT NULL,
  customer_name VARCHAR(180) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(80) NULL,
  product_name VARCHAR(255) NULL,
  source_action ENUM('phone','email','contact') NOT NULL DEFAULT 'contact',
  message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_connect_supplier
    FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id)
    ON DELETE CASCADE,
  INDEX idx_connect_supplier (supplier_id, created_at),
  INDEX idx_connect_customer (customer_email, created_at)
) ENGINE=InnoDB;
