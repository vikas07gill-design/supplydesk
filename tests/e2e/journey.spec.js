const { test, expect } = require("@playwright/test");
const fs = require("fs"), path = require("path");
// Journey: one order from the buyer's request to the supplier's payment. Drives every role, takes a screenshot of
// each role's own screen at each step and writes journey.json. Run with JOURNEY_DIR=/some/dir to keep the output.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!KEY || !AID || !APW || !SID || !SPW, "needs admin + super admin env");
test.describe.configure({ mode: "serial" });
test.setTimeout(240000);
const stamp = Date.now(), PW = "Role-Test-Pass-123";
const OUT = process.env.JOURNEY_DIR || path.join(require("os").tmpdir(), "journey-" + stamp);
fs.mkdirSync(OUT, { recursive: true });
const sess = {};
const login = async (request, id, pw) => sess[id] || (sess[id] = { token: (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json()).token });
const H = (s) => ({ "x-admin-token": s.token || s });
const steps = [];
let n = 0;

async function buyer(request, tag) {
  const email = `aw-${tag}-${stamp}-${Math.floor(Math.random() * 1e5)}@example.com`;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  return { email, token: v.dashboardToken, h: { "x-buyer-dashboard-token": v.dashboardToken } };
}
async function newRequirement(request, b, tag, qty = 1000) {
  const r = await request.post("/api/buyer-requirements", { data: { dashboardToken: b.token, buyerName: "Secret Buyer " + tag, buyerCompany: "Secret Buyer Co " + tag, buyerCountry: "India", title: `AW ${tag} ${stamp}`, description: "Need containers", specification: "std", certifications: "none", packaging: "carton", paymentTerms: "30% advance", incoterm: "FOB", category: "Plastics & Polymers", subcategory: "Containers", quantity: String(qty), unit: "pcs", targetPrice: 99.5, currency: "INR", deliveryCity: "Pune", requiredBy: "2030-01-01" } });
  expect(r.status()).toBe(201);
  return (await r.json()).requirementId;
}
const review = (request, ah, id, data) => request.post(`/api/admin/requirements/${id}/review`, { headers: ah, data });

// A supplier that is fully approved, with one verified product of the given free capacity.
async function makeSupplier(request, ah, tag, free, region, lead) {
  const email = `aws-${tag}-${stamp}@example.com`.toLowerCase(), company = `Plan Supplier ${tag} ${stamp}`;
  const ask = await (await request.post("/api/supplier-signup/request-otp", { headers: { "x-e2e-key": KEY }, data: { company, contact: "Owner " + tag, email, phone: "+91 98100 00000", country: "India" } })).json();
  const v = await (await request.post("/api/supplier-signup/verify-otp", { data: { email, otp: ask.testOtp } })).json();
  const sh = { "x-supplier-dashboard-token": v.token };
  const name = `Plan Container ${tag} ${stamp}`;
  expect((await request.post("/api/supplier-dashboard/products", { headers: sh, data: { product_name: name, category: "Plastics & Polymers", subcategory: "Containers", moq: "10", unit: "pcs", monthly_capacity: free * 2, available_capacity: free, capacity_unit: "pcs", lead_time_days: lead, origin_region: region } })).status()).toBeLessThan(300);
  const prod = (await (await request.get("/api/supplier-dashboard/products", { headers: sh })).json()).products.find(p => p.product_name === name);
  const su = H(await login(request, SID, SPW));
  const pid = (await (await request.get("/api/super-admin/suppliers?q=" + encodeURIComponent(email), { headers: su })).json()).suppliers.find(x => x.business_email === email).id;
  const move = (status, extra = {}) => request.patch(`/api/admin/suppliers/${pid}/onboarding`, { headers: ah, data: { status, ...extra } });
  expect((await move("business_verification_pending")).status()).toBe(200);
  expect((await move("business_verified")).status()).toBe(200);
  expect((await move("capability_verification_pending")).status()).toBe(200);
  expect((await request.patch(`/api/admin/products/${prod.id}`, { headers: ah, data: { status: "approved" } })).status()).toBe(200);
  expect((await request.post(`/api/admin/products/${prod.id}/capacity-verification`, { headers: ah, data: { verified: true } })).status()).toBe(200);
  expect((await move("capability_verified")).status()).toBe(200);
  expect((await move("supplydesk_approved", { agreementSigned: true })).status()).toBe(200);
  return { sh, pid, email, code: prod.capability_code, productId: prod.id, company };
}

// Buyer request -> accepted -> quoted -> buyer accepts -> returns { orderId, sdOrderId }
async function orderViaFlow(request, ah, b, tag, qty) {
  const id = await newRequirement(request, b, tag, qty);
  expect((await review(request, ah, id, { action: "accept_full" })).status()).toBe(200);
  expect((await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: ah, data: { unitPrice: 50, quantity: qty + " pcs" } })).status()).toBe(201);
  const acc = await (await request.post(`/api/buyer-requirements/${id}/quote/respond`, { headers: b.h, data: { decision: "accept" } })).json();
  const o = (await (await request.get("/api/admin/orders", { headers: ah })).json()).orders.find(x => x.id === acc.orderId);
  return { requirementId: id, orderId: acc.orderId, poNumber: acc.poNumber, sdOrderId: o.sd_order_id };
}



let su, ah, P, M, B, F, SUP = {}, w;
const team = async (request, role, name) => {
  const adminId = `j-${role}.${stamp}`;
  expect((await request.post("/api/super-admin/team", { headers: su, data: { adminId, displayName: name, role, password: PW } })).status()).toBe(201);
  return { adminId, name, ...(await (await request.post("/api/admin/login", { data: { adminId, password: PW } })).json()) };
};
const spo = (request, sup, id, status) => request.patch(`/api/supplier-dashboard/purchase-orders/${id}/status`, { headers: sup.sh, data: { status, note: "ok" } });

// Record a step: what happened, who did it, and (optionally) what that person's screen looks like.
async function step(browser, title, who, did, view) {
  const rec = { n: ++n, title, who, did, shot: null };
  if (view) {
    const ctx = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL, viewport: { width: 1280, height: 820 } });
    const page = await ctx.newPage();
    await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [view.user.token, view.user.role]);
    await page.goto("/admin.html");
    await view.go(page);
    await page.waitForTimeout(500);
    rec.shot = `step-${String(n).padStart(2, "0")}.png`;
    await page.screenshot({ path: path.join(OUT, rec.shot), fullPage: true });
    rec.shotBy = view.label;
    await ctx.close();
  }
  steps.push(rec);
  fs.writeFileSync(path.join(OUT, "journey.json"), JSON.stringify(steps, null, 2));
}
const nav = (group, label) => async (page) => { await page.locator(group + " button", { hasText: new RegExp("^" + label) }).first().click(); };
const sourcing = (group, label) => async (page) => { await nav("#opsGroup", "Sourcing")(page); await page.locator(".rq-row").first().click(); await page.locator("#detail h2").first().waitFor(); };

test("the whole journey, one order, every role", async ({ request, browser }) => {
  su = H(await login(request, SID, SPW)); ah = H(await login(request, AID, APW));
  for (const [k, free] of [["A", 5000], ["B", 5000], ["C", 5000]]) SUP[k] = await makeSupplier(request, ah, "j" + k, free, "Delhi", 10);
  P = await team(request, "procurement", "Priya (Procurement)"); M = await team(request, "management", "Manoj (Management)");
  B = await team(request, "buyer_desk", "Bhavna (Buyer Desk)"); F = await team(request, "finance", "Farhan (Finance)");

  // 1. Buyer asks
  const buyerAcc = await buyer(request, "journey");
  const reqId = await newRequirement(request, buyerAcc, "journey", 1000);
  await step(browser, "Buyer posts a requirement", "Buyer", "Aarav (Mehta Packaging) asks for 1,000 plastic containers and shares a target price of Rs 42.", { user: { ...(await login(request, SID, SPW)), role: "super_admin" }, label: "Super Admin - Requests", go: async (pg) => { await pg.locator("#requirementsBtn").click(); await pg.locator(".rq-row").first().click(); await pg.locator("#detail h2").first().waitFor(); } });

  // 2. Super Admin accepts, prices and the buyer accepts the quote
  expect((await request.post(`/api/admin/requirements/${reqId}/review`, { headers: su, data: { action: "accept_full" } })).status()).toBe(200);
  expect((await request.post(`/api/admin/requirements/${reqId}/buyer-quote`, { headers: su, data: { unitPrice: 50, quantity: "1000 pcs" } })).status()).toBe(201);
  const acc = await (await request.post(`/api/buyer-requirements/${reqId}/quote/respond`, { headers: buyerAcc.h, data: { decision: "accept" } })).json();
  const ord = (await (await request.get("/api/admin/orders", { headers: su })).json()).orders.find(x => x.id === acc.orderId);
  w = { reqId, orderId: acc.orderId, sdId: ord.sd_order_id, buyer: buyerAcc };
  await step(browser, "Super Admin accepts and quotes; buyer accepts", "Super Admin / Buyer", "Accepted in full, quoted Rs 50 a piece. The buyer accepted, so a SupplyDesk order was created automatically.", { user: { ...(await login(request, SID, SPW)), role: "super_admin" }, label: "Super Admin - Sourcing plan", go: sourcing() });

  // 3. Buy-below price and release to the desks
  expect((await request.put(`/api/admin/sd-orders/${w.sdId}/buy-ceiling`, { headers: H(M), data: { unitPrice: 40 } })).status()).toBe(200);
  expect((await request.put("/api/admin/assignments", { headers: su, data: { entityType: "sd_order", entityId: w.sdId, desk: "procurement", adminId: P.adminId } })).status()).toBe(200);
  expect((await request.put("/api/admin/assignments", { headers: su, data: { entityType: "requirement", entityId: w.reqId, desk: "buyer", adminId: B.adminId } })).status()).toBe(200);
  await step(browser, "Management sets the buy-below price and releases the order to desks", "Management", "Buy below Rs 40 a piece. Priya (Procurement) gets the sourcing; Bhavna (Buyer Desk) keeps the buyer. Priya never sees the Rs 50.", { user: P, label: "Procurement - My desk", go: async () => {} });

  // 4. Procurement collects 3 rates
  const rate = (code, unitRate) => request.put(`/api/admin/sd-orders/${w.sdId}/rate-quotes`, { headers: H(P), data: { capabilityCode: code, unitRate, leadTimeDays: 12 } });
  expect((await rate(SUP.A.code, 38)).status()).toBe(200); expect((await rate(SUP.B.code, 36)).status()).toBe(200); expect((await rate(SUP.C.code, 45)).status()).toBe(200);
  await step(browser, "Procurement collects supplier rates", "Procurement", "Three suppliers quoted Rs 38, Rs 36 and Rs 45. The Rs 45 one is above the limit and cannot be chosen.", { user: P, label: "Procurement - Sourcing plan", go: sourcing() });

  // 5. Final choice
  const sub = await request.post(`/api/admin/sd-orders/${w.sdId}/sourcing-plan/submit`, { headers: H(P), data: { lines: [{ capabilityCode: SUP.A.code, quantity: 400 }, { capabilityCode: SUP.B.code, quantity: 600 }] } });
  expect(sub.status()).toBe(200);
  await step(browser, "Procurement submits the final choice", "Procurement", "400 from the Rs 38 supplier and 600 from the Rs 36 supplier. Nothing goes to the suppliers yet.", { user: M, label: "Management - Sourcing plan (review)", go: sourcing() });

  // 6. Release POs
  const draft = (await (await request.get(`/api/admin/sd-orders/${w.sdId}/sourcing-plan`, { headers: H(M) })).json()).draft;
  expect((await request.post(`/api/admin/sd-orders/${w.sdId}/sourcing-plan/confirm`, { headers: H(M), data: { lines: draft } })).status()).toBe(201);
  await step(browser, "Management releases the Supplier POs", "Management", "POs go to the two suppliers at the final rates, with SupplyDesk as the customer. Management now sees selling, buying and margin together.", { user: M, label: "Management - Sourcing plan (released)", go: sourcing() });

  // 7. Production
  for (const k of ["A", "B"]) { const id = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: SUP[k].sh })).json()).purchaseOrders[0].id; for (const st of ["accepted", "in_production", "ready_for_qc"]) expect((await spo(request, SUP[k], id, st)).status()).toBe(200); }
  await step(browser, "Suppliers produce", "Suppliers", "Both suppliers accepted, produced and handed over for QC. Priya's desk shows QC is due.", { user: P, label: "Procurement - My desk", go: async () => {} });

  // 8. QC
  expect((await request.post(`/api/admin/orders/${w.orderId}/stage`, { headers: H(P), data: { stage: "qc_completed" } })).status()).toBe(200);
  await step(browser, "Procurement signs off QC", "Procurement", "Priya marked QC completed. The order moves to Finance for billing and to the Buyer Desk for delivery.", { user: F, label: "Finance - My desk", go: async () => {} });

  // 9. Billing
  const inv = await request.post(`/api/admin/orders/${w.orderId}/invoice`, { headers: H(F), data: { gstRate: 18 } });
  expect(inv.status()).toBe(201);
  const invId = (await inv.json()).invoiceId;
  expect((await request.post(`/api/admin/invoices/${invId}/release`, { headers: H(F) })).status()).toBe(200);
  await step(browser, "Finance issues the sale invoice and releases it to the team", "Finance", "Invoice for Rs 50,000 + 18% GST. It stays with Finance until released; now the Buyer Desk and the buyer can see it.", { user: B, label: "Buyer Desk - My desk", go: async () => {} });

  // 10. Delivery by the Buyer Desk
  for (const k of ["A", "B"]) { const id = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: SUP[k].sh })).json()).purchaseOrders[0].id; for (const st of ["ready_for_dispatch", "dispatched", "completed"]) expect((await spo(request, SUP[k], id, st)).status()).toBe(200); }
  for (const st of ["ready_for_transport", "transport_booked", "insurance_completed", "in_transit", "out_for_delivery", "delivered"]) expect((await request.post(`/api/admin/orders/${w.orderId}/stage`, { headers: H(B), data: { stage: st } })).status(), st).toBe(200);
  await step(browser, "Buyer Desk delivers", "Buyer Desk", "Bhavna arranged transport and insurance with the buyer and marked it delivered.", null);

  // 11. Money to suppliers
  const poIds = []; for (const k of ["A", "B"]) poIds.push((await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: SUP[k].sh })).json()).purchaseOrders[0].id);
  const pays = [];
  for (const id of poIds) { const r = await request.post(`/api/admin/supplier-pos/${id}/payable`, { headers: H(P), data: {} }); expect(r.status()).toBe(201); pays.push((await r.json()).id); }
  await step(browser, "Procurement raises supplier payables", "Procurement", "One payable per PO, capped at the PO value (Rs 15,200 and Rs 21,600).", { user: M, label: "Management - Approvals", go: nav("#toolsGroup", "Approvals") });
  for (const id of pays) expect((await request.post(`/api/admin/payables/${id}/approve`, { headers: H(M) })).status()).toBe(200);
  await step(browser, "Management approves the payables", "Management", "Approved. Finance can now pay.", { user: F, label: "Finance - My desk", go: async () => {} });
  for (const id of pays) expect((await request.post(`/api/admin/payables/${id}/pay`, { headers: H(F), data: { reference: "UTR" + stamp + pays.indexOf(id) } })).status()).toBe(200);

  // 12. The owner's view
  await step(browser, "Management reads the scorecards", "Management", "Priya saved 8% under the buy-below price. Everything each person did is recorded.", { user: M, label: "Management - Scorecards", go: nav("#toolsGroup", "Scorecards") });
  await step(browser, "Who did what", "Super Admin", "The full trail of the order, from the first request to the last payment.", { user: { ...(await login(request, SID, SPW)), role: "super_admin" }, label: "Super Admin - Who did what", go: async (pg) => { await nav("#opsGroup", "Sourcing")(pg); await pg.locator(".rq-row").first().click(); await pg.getByRole("tab", { name: /History/ }).click(); await pg.locator("button", { hasText: "Who did what" }).click(); await pg.locator("#spTrail .tl-i").first().waitFor(); } });
  const bv = await (await request.get("/api/buyer-requirements", { headers: w.buyer.h })).json();
  steps.push({ n: ++n, title: "What the buyer saw", who: "Buyer", did: "Only SupplyDesk-controlled stages and the released invoice. No supplier, no buying rate, no margin.", shot: null, buyerView: JSON.stringify(bv).includes("Supplier ") ? "LEAK" : "clean" });
  fs.writeFileSync(path.join(OUT, "journey.json"), JSON.stringify(steps, null, 2));
  expect(JSON.stringify(bv)).not.toMatch(/unit_cost|supplier_po|Plan Supplier/);
});
