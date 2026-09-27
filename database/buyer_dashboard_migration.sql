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