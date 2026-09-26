-- SupplyDesk connection request status tracking
-- Run once in database: u327213615_supplydesk

ALTER TABLE connect_requests
  ADD COLUMN status ENUM('new','contacted','in_discussion','closed') NOT NULL DEFAULT 'new' AFTER message,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

ALTER TABLE connect_requests
  ADD INDEX idx_connect_status (status, created_at);
