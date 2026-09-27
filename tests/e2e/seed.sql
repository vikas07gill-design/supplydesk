SET FOREIGN_KEY_CHECKS=0;
DELETE FROM buyer_enquiries;
DELETE FROM buyer_email_otps;
DELETE FROM buyer_dashboard_tokens;
DELETE FROM buyers;
DELETE FROM supplier_products WHERE id='00000000-0000-4000-8000-000000000003';
DELETE FROM supplier_profiles WHERE id='00000000-0000-4000-8000-000000000002';
DELETE FROM supplier_verification WHERE application_id='00000000-0000-4000-8000-000000000001';
DELETE FROM supplier_applications WHERE id='00000000-0000-4000-8000-000000000001';
SET FOREIGN_KEY_CHECKS=1;

INSERT INTO supplier_applications
(id,legal_name,trade_name,business_type,country,city,address,business_email,business_phone,contact_person,designation,category,subcategory,status)
VALUES
('00000000-0000-4000-8000-000000000001','India Growth E2E Supplier','India Growth','Manufacturer','India','Delhi','E2E Test Address','supplier-e2e@example.com','9999999999','E2E Test Contact','Director','Plastics & Packaging','Plastic Containers','approved');

INSERT INTO supplier_profiles
(id,application_id,legal_name,trade_name,business_type,country,city,address,website,business_email,business_phone,contact_person,designation,category,subcategory,verified,published,profile_details_json)
VALUES
('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','India Growth E2E Supplier','India Growth','Manufacturer','India','Delhi','E2E Test Address','https://example.com','supplier-e2e@example.com','9999999999','E2E Test Contact','Director','Plastics & Packaging','Plastic Containers',1,1,'{"about":"Automated test supplier","capabilities":"Automated end-to-end test supplier"}');

INSERT INTO supplier_products
(id,supplier_id,product_name,category,subcategory,description,moq,unit,market_scope,status,reviewed_at)
VALUES
('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','E2E Test Product','Plastics & Packaging','Plastic Containers','Product used only by automated CI tests.','10','pcs','Both','approved',NOW());
