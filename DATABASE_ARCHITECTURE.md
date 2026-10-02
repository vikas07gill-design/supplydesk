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


## RFQ / quotation flow

- `buyers -> buyer_requirements` stores buyer sourcing requirements.
- `buyer_requirements -> requirement_supplier_matches` records supplier visibility/view state.
- `buyer_requirements -> supplier_quotes -> supplier_profiles` stores supplier commercial quotations.
- Buyer contact details remain protected from suppliers in the requirement inbox.
- Suppliers see matched open requirements and can submit/update one quotation per requirement.
- Buyers can review received quotations from the Buyer Dashboard.
- Admin can review requirements and all supplier quotations.


## Phase 1A: capacity-first listings (SupplyDesk sells to the buyer)

- `supplier_products` now carries `monthly_capacity`, `available_capacity`, `capacity_unit`, `lead_time_days`, `origin_region`, `capacity_updated_at` and a unique `capability_code` (e.g. `SD-PLA-7K3Q`). Capacity is time-sensitive: the public API marks it "being reconfirmed" after 45 days without an update. Supplier capacity updates (`PATCH /api/supplier-dashboard/products/:id/capacity`) do not send a listing back for review.
- Public APIs return a capacity **band** (never the exact number), availability status, lead time, MOQ and region. They never return the supplier name, id, website or contact.
- `SD_HIDE_SUPPLIERS` (default `true`) controls this. Setting it to `false` restores the old public supplier profiles and direct connect flow (rollback switch).
- A buyer "Request Quote" creates a `buyer_enquiries` + `connect_requests` row and notifies only the buyer. The supplier receives nothing. Admin decides with `POST /api/admin/connect-requests/:id/decision` (`accepted` / `partial` + `approved_quantity` / `rejected`, remarks required for partial and rejected). The decision, quantity and remarks are stored on `buyer_enquiries` and shown in the Buyer Dashboard and by email.

## Phase 1B: structured RFQ, state machine, audit log

- `buyer_requirements` gains `rfq_code` (`RFQ-YYYYMM-XXXX`, unique), `rfq_state`, `state_changed_at`, `specification`, `quality_standards`, `certifications`, `packaging`, `payment_terms`, `incoterm`. Added by `ensureRfqSchema()` at startup (additive; old rows are backfilled from the legacy `status`). The legacy `status` ENUM is kept for backward compatibility.
- States and allowed moves live in `rfq.js` (pure functions): submitted, matching, sourcing, quotes_received, costing, quote_sent, buyer_approved, converted, lost, rejected, closed, cancelled. All moves go through `moveRfq()` which locks the row, rejects illegal moves (HTTP 409) and writes `audit_log`.
- `audit_log` records actor, role, action, entity, old/new value for RFQ creation/state moves, supplier quotes, capacity updates and quote-request decisions.
- Admin endpoints: `GET /api/admin/procurement/queue`, `POST /api/admin/requirements/:id/state`, `GET /api/admin/requirements/:id/capability-matches`, `GET /api/admin/audit`.

## Phase 2: SupplyDesk quote -> buyer decision -> order

- `rfq_quotes`: the single SupplyDesk price sent to the buyer (quote_no `SQ-YYYYMM-XXXX`, unit price, quantity, total, lead time, validity, terms). A new quote supersedes the previous open one. Supplier identity/price is never stored here.
- `orders`: created when the buyer accepts (`PO-YYYYMM-XXXX`, one order per RFQ). Order states: confirmed, in_production, shipped, delivered, cancelled (rules in `rfq.js`). Payment is handled manually for now.
- Buyer flow: RFQ moves quote_sent -> buyer_approved -> converted on accept, or -> lost on decline. Expired quotes (valid_until) cannot be accepted. `quote_sent -> costing` allows revising a quote.
- Endpoints: `POST /api/admin/requirements/:id/buyer-quote`, `POST /api/buyer-requirements/:id/quote/respond`, `GET /api/buyer-orders`, `GET /api/admin/orders`, `PATCH /api/admin/orders/:id/status`. With `SD_HIDE_SUPPLIERS=true` the buyer's quotes endpoint returns only SupplyDesk quotes (`sdQuotes`), never raw supplier quotes.
- Supplier cost prices (supplier quotes) are visible to Admin and Super Admin; supplier identity stays Super Admin only.

## Phase 3: supplier purchase orders

- `supplier_pos` (`SPO-YYYYMM-XXXX`): SupplyDesk's PO to a supplier for a confirmed buyer order. Holds only neutral order title, quantity, unit cost, delivery date and terms. The supplier never receives the buyer's identity or buyer price.
- States (rules in `rfq.js`): issued -> accepted/declined; accepted -> in_production -> dispatched -> completed; admin can cancel before dispatch. Declining needs a reason.
- Admin issues a PO by Capability ID (so Admin never needs supplier identity); Super Admin may also pass a supplier id. Admin sees an alias, Super Admin sees the supplier name.
- Endpoints: `POST /api/admin/orders/:id/supplier-po`, `GET /api/admin/orders/:id/supplier-pos`, `PATCH /api/admin/supplier-pos/:id/cancel`, `GET /api/supplier-dashboard/purchase-orders`, `PATCH /api/supplier-dashboard/purchase-orders/:id/status`. Test mode (`E2E_TEST_MODE` + `x-e2e-key`) also works for supplier dashboard OTP.
- The buyer-facing order status is still updated by SupplyDesk manually; supplier PO status is internal.

## Phase 4: buyer order follows supplier progress

`syncOrderFromPos()` (server.js) keeps `orders.status` in step with live supplier POs (declined/cancelled ignored): confirmed -> in_production when any PO starts production; in_production -> shipped when every live PO is dispatched/completed. It never moves backwards, never sets delivered (SupplyDesk confirms delivery manually) and writes an audit row; the buyer is emailed on each automatic change. No schema change.

## Phase 5: invoices and payment tracking

- `invoices` (`INV-YYYYMM-XXXX`): one active invoice per order (subtotal defaults to the order total, GST % 0-28, GST amount and total computed in integer paise by `rfq.js`). Status: issued, partially_paid, paid, void. Void only when no payment is recorded.
- `payments`: manual receipts (bank transfer, UPI, cheque, cash, other) with reference and date; overpayment is rejected; status updates from the paid total.
- This is an internal tracking record, NOT a statutory GST tax invoice (no GSTIN/HSN/place of supply). Confirm requirements with a CA before using it as one.
- Endpoints: `POST/GET /api/admin/orders/:id/invoice`, `POST /api/admin/invoices/:id/payments`, `PATCH /api/admin/invoices/:id/void`, `GET /api/buyer-invoices`. Buyer is emailed on invoice issue and on each payment.

## Phase 6: margin (Super Admin only)

- `rfq_quotes` gains `cost_unit_price` and `markup_pct` (additive columns). Markup is on supplier cost: price = cost x (1 + markup%). Only Super Admin can price by markup (server recomputes the price; the client value is ignored). Admin may still record the supplier cost and type the final price; the margin is never returned by any Admin endpoint, buyer endpoint or the audit log.
- `GET /api/super-admin/margin-report`: per order revenue (accepted SupplyDesk price), cost (active supplier POs, else the cost noted on the quote) and margin, with totals per currency.
