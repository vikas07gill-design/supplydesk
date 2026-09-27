# SupplyDesk database architecture

## Source of truth

The live Node.js application uses MySQL through mysql2. The production database is the Hostinger MySQL database configured by DB_HOST, DB_NAME, DB_USER and DB_PASSWORD.

- Canonical Hostinger/phpMyAdmin setup: database/hostinger.sql
- Local MySQL schema: database/schema.sql
- Incremental migrations in database/*_migration.sql are historical/upgrade scripts.
- supabase/schema.sql is not used by the current Node.js backend. Do not maintain a second live data path unless the backend is intentionally migrated to Supabase.

## Core relationship map

supplier_applications -> supplier_profiles
supplier_profiles -> supplier_products -> supplier_product_files
supplier_profiles -> supplier_profile_views / supplier_dashboard_tokens / supplier_dashboard_otps
supplier_profiles -> supplier_update_tokens / supplier_update_requests -> supplier_update_files
buyers -> buyer_enquiries -> supplier_profiles / supplier_products
connect_requests -> buyer_enquiries

Buyer identity is created only after the buyer verifies their email during the first enquiry.

## Launch rules

- buyers.email is unique, so the same verified buyer is reused.
- supplier_profiles.application_id is unique, so approval does not create duplicate supplier profiles.
- Every public product belongs to a published, verified supplier.
- Every buyer enquiry points to one buyer and one supplier, and optionally one supplier product.
- Every connection request should point to its corresponding buyer enquiry through connect_requests.enquiry_id.

## Legacy URLs

Older supplier URLs may use a human-readable slug such as supplier.html?id=india-growth. The public supplier API resolves both the canonical UUID and the legacy slug so old links continue to work.

## Deployment

For an existing Hostinger database, let the application startup schema check run after deployment. It creates missing launch tables and adds the current profile/enquiry links without deleting existing business data.
