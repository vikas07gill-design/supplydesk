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
CREATE TABLE IF NOT EXISTS supplier_payables (
  id CHAR(36) PRIMARY KEY,
  supplier_po_id CHAR(36) NOT NULL,
  sd_order_id CHAR(36) NULL,
  supplier_id CHAR(36) NOT NULL,
  amount DECIMAL(16,2) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  status ENUM('pending_approval','approved','rejected','paid') NOT NULL DEFAULT 'pending_approval',
  note VARCHAR(300) NULL,
  raised_by VARCHAR(120) NOT NULL,
  raised_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by VARCHAR(120) NULL,
  decided_at DATETIME NULL,
  decision_note VARCHAR(300) NULL,
  paid_by VARCHAR(120) NULL,
  paid_at DATETIME NULL,
  payment_ref VARCHAR(120) NULL,
  UNIQUE KEY uq_payable_po (supplier_po_id),
  INDEX idx_payable_status (status, raised_at)
) ENGINE=InnoDB;
