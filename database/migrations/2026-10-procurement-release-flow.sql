-- Also applied automatically on server start (ensureFlowSchema).

-- Buy-below price, supplier rate comparison and invoice release
ALTER TABLE sd_orders ADD COLUMN buy_ceiling DECIMAL(14,2) NULL, ADD COLUMN buy_ceiling_currency VARCHAR(10) NULL, ADD COLUMN plan_proposed_by VARCHAR(120) NULL, ADD COLUMN plan_proposed_at DATETIME NULL, ADD COLUMN single_source_note VARCHAR(300) NULL;
CREATE TABLE IF NOT EXISTS sd_rate_quotes (
  id CHAR(36) PRIMARY KEY,
  sd_order_id CHAR(36) NOT NULL,
  capability_code VARCHAR(30) NOT NULL,
  supplier_id CHAR(36) NOT NULL,
  unit_rate DECIMAL(14,2) NOT NULL,
  lead_time_days INT NULL,
  note VARCHAR(300) NULL,
  created_by VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rate_quote (sd_order_id, capability_code)
) ENGINE=InnoDB;
ALTER TABLE invoices ADD COLUMN released_at DATETIME NULL, ADD COLUMN released_by VARCHAR(120) NULL;
UPDATE invoices SET released_at = created_at WHERE released_at IS NULL;
