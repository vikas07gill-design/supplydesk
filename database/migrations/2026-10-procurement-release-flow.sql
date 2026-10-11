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

-- Products listed by a team member on behalf of a supplier (the lister cannot approve their own listing).
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS listed_by_admin VARCHAR(120) NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_pct TINYINT NOT NULL DEFAULT 50;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'full';

-- Supplier side: documents, invoices (30 days credit), messages
CREATE TABLE IF NOT EXISTS supplier_po_documents (id CHAR(36) PRIMARY KEY, supplier_po_id CHAR(36) NOT NULL, supplier_id CHAR(36) NOT NULL, kind VARCHAR(30) NOT NULL, original_name VARCHAR(255) NOT NULL, relative_path VARCHAR(500) NOT NULL, mime_type VARCHAR(100) NOT NULL, file_size INT NOT NULL, uploaded_by VARCHAR(20) NOT NULL DEFAULT 'supplier', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_spd_po (supplier_po_id));
CREATE TABLE IF NOT EXISTS supplier_invoices (id CHAR(36) PRIMARY KEY, supplier_po_id CHAR(36) NOT NULL, supplier_id CHAR(36) NOT NULL, invoice_no VARCHAR(60) NOT NULL, invoice_date DATE NOT NULL, taxable DECIMAL(16,2) NOT NULL, gst DECIMAL(16,2) NOT NULL DEFAULT 0, total DECIMAL(16,2) NOT NULL, currency VARCHAR(10) NOT NULL, due_date DATE NOT NULL, status ENUM('submitted','accepted','rejected') NOT NULL DEFAULT 'submitted', decision_note VARCHAR(300) NULL, decided_by VARCHAR(120) NULL, decided_at DATETIME NULL, original_name VARCHAR(255) NOT NULL, relative_path VARCHAR(500) NOT NULL, mime_type VARCHAR(100) NOT NULL, file_size INT NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY uq_si_supplier_no (supplier_id, invoice_no), INDEX idx_si_po (supplier_po_id));
CREATE TABLE IF NOT EXISTS supplier_po_messages (id CHAR(36) PRIMARY KEY, supplier_po_id CHAR(36) NOT NULL, sender ENUM('supplier','team') NOT NULL, admin_id VARCHAR(120) NULL, body VARCHAR(1500) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_spm_po (supplier_po_id));
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS invoice_id CHAR(36) NULL;
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS due_date DATE NULL;
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS early_ok TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS early_reason VARCHAR(300) NULL;
