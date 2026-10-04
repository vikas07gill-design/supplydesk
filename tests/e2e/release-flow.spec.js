const { test, expect } = require("@playwright/test");
// Release flow: buy-below price -> supplier rates -> proposal -> release POs -> production -> QC (Procurement)
// -> billing (Finance) -> invoice released -> delivery (Buyer Desk). Super Admin sees both sides throughout.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!KEY || !AID || !APW || !SID || !SPW, "needs admin + super admin env");
test.describe.configure({ mode: "serial" });

const stamp = Date.now(), PW = "Role-Test-Pass-123";
const sess = {};
const login = async (request, id, pw) => sess[id] || (sess[id] = { token: (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json()).token });
const H = (s) => ({ "x-admin-token": s.token || s });

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


let su, ah, P, M, B, F, SUP = {}, w, planBase;
const team = async (request, role) => {
  const adminId = `rf-${role}.${stamp}`;
  expect((await request.post("/api/super-admin/team", { headers: su, data: { adminId, displayName: role, role, password: PW } })).status()).toBe(201);
  return { adminId, ...(await (await request.post("/api/admin/login", { data: { adminId, password: PW } })).json()) };
};
const spo = (request, sup, poId, status) => request.patch(`/api/supplier-dashboard/purchase-orders/${poId}/status`, { headers: sup.sh, data: { status, note: "ok" } });

test("setup: suppliers, a buyer order in a SupplyDesk order, and one user per role", async ({ request }) => {
  su = H(await login(request, SID, SPW)); ah = H(await login(request, AID, APW));
  for (const [k, free] of [["A", 5000], ["B", 5000], ["C", 5000]]) SUP[k] = await makeSupplier(request, ah, "rf" + k, free, "Delhi", 10);
  const b = await buyer(request, "rf");
  w = await orderViaFlow(request, ah, b, "rf", 1000);
  w.b = b;
  P = await team(request, "procurement"); M = await team(request, "management"); B = await team(request, "buyer_desk"); F = await team(request, "finance");
  expect(w.sdOrderId).toBeTruthy();
});

test("Super Admin sets the buy-below price; work cannot be released to Procurement without it", async ({ request }) => {
  const asg = (adminId) => request.put("/api/admin/assignments", { headers: su, data: { entityType: "sd_order", entityId: w.sdOrderId, desk: "procurement", adminId } });
  const r = await asg(P.adminId);
  expect(r.status()).toBe(409); expect((await r.json()).code).toBe("ceiling_required");
  const ceil = (h, unitPrice) => request.put(`/api/admin/sd-orders/${w.sdOrderId}/buy-ceiling`, { headers: h, data: { unitPrice } });
  expect((await ceil(H(P), 40)).status()).toBe(403);   // only Management / Super Admin decide the price
  expect((await ceil(su, -5)).status()).toBe(400);
  expect((await ceil(H(M), 40)).status()).toBe(200);
  expect((await asg(P.adminId)).status()).toBe(200);
  expect((await request.put("/api/admin/assignments", { headers: su, data: { entityType: "requirement", entityId: w.requirementId, desk: "buyer", adminId: B.adminId } })).status()).toBe(200);
});

test("Procurement sees the buy-below price but never the selling price or buyer; Super Admin sees both sides", async ({ request }) => {
  const pl = await request.get(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan`, { headers: H(P) });
  const pj = await pl.json();
  expect(pj.buyCeiling.rate).toBe(40);
  expect(pj.economics).toBeNull();
  const txt = JSON.stringify(pj);
  expect(txt).not.toContain(w.b.email); expect(txt).not.toMatch(/"(unit_price|total_price|totalPrice|unitPrice)"/);
  expect(pj.candidates.length).toBeGreaterThanOrEqual(3);
  const sj = await (await request.get(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan`, { headers: su })).json();
  expect(sj.economics.revenue).toBe(50000);
  expect(sj.buyCeiling.rate).toBe(40);
  planBase = pj;
});

test("supplier rates are compared; the plan is proposed only within the buy-below price", async ({ request }) => {
  const rate = (code, unitRate, h = H(P)) => request.put(`/api/admin/sd-orders/${w.sdOrderId}/rate-quotes`, { headers: h, data: { capabilityCode: code, unitRate, leadTimeDays: 12 } });
  const submit = (lines, extra = {}) => request.post(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan/submit`, { headers: H(P), data: { lines, ...extra } });
  expect((await rate("NOPE-0000", 30)).status()).toBe(400);
  // nothing quoted yet
  expect((await submit([{ capabilityCode: SUP.A.code, quantity: 400 }])).status()).toBe(400);
  expect((await rate(SUP.A.code, 38)).status()).toBe(200);
  // one quote only: needs a reason
  const one = await submit([{ capabilityCode: SUP.A.code, quantity: 1000 }]);
  expect(one.status()).toBe(400); expect((await one.json()).code).toBe("need_quotes");
  expect((await rate(SUP.B.code, 36)).status()).toBe(200);
  const hi = await rate(SUP.C.code, 45);
  expect((await hi.json()).overCeiling).toBe(true);
  // choosing the over-ceiling supplier is refused
  const over = await submit([{ capabilityCode: SUP.C.code, quantity: 1000 }]);
  expect(over.status()).toBe(409); expect((await over.json()).code).toBe("over_ceiling");
  const ok = await submit([{ capabilityCode: SUP.A.code, quantity: 400 }, { capabilityCode: SUP.B.code, quantity: 600 }]);
  expect(ok.status()).toBe(200);
  const pj = await (await request.get(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan`, { headers: H(P) })).json();
  expect(pj.sdOrder.planStatus).toBe("proposed");
  expect(pj.rateQuotes.length).toBe(3);
  expect(pj.draft.map(l => l.unitCost).sort()).toEqual([36, 38]);
  // Procurement cannot release POs itself
  expect((await request.post(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan/confirm`, { headers: H(P), data: { lines: pj.draft } })).status()).toBe(403);
});

test("UI: Procurement sees the limit and rates; Management sees the release button", async ({ page }) => {
  const open = async (u) => {
    await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [u.token, u.role]);
    await page.goto("/admin.html");
    await page.locator("#opsGroup button", { hasText: /^Sourcing$/ }).click();
    await page.locator(".rq-row", { hasText: /Plan Container|RF|rf/ }).first().click();
  };
  await open(P);
  await expect(page.locator("#detail")).toContainText("Buy below");
  await expect(page.locator("#detail")).toContainText("40 INR / unit");
  await expect(page.locator("#detail")).toContainText("Waiting for Management to release the POs");
  await expect(page.locator("#detail .nt-t", { hasText: /SupplierRateLead/ }).first()).toContainText("above limit");
  await expect(page.locator("#detail")).not.toContainText("50000");
  await expect(page.locator("#detail button", { hasText: "Release Supplier POs" })).toHaveCount(0);
});

test("Management releases the POs at the final rates; over-ceiling needs explicit approval", async ({ request }) => {
  const draft = (await (await request.get(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan`, { headers: H(M) })).json()).draft;
  const bad = await request.post(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan/confirm`, { headers: H(M), data: { lines: draft.map(l => ({ ...l, unitCost: 45 })) } });
  expect(bad.status()).toBe(409); expect((await bad.json()).code).toBe("over_ceiling");
  const rel = await request.post(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan/confirm`, { headers: H(M), data: { lines: draft } });
  expect(rel.status()).toBe(201);
  const sj = await (await request.get(`/api/admin/sd-orders/${w.sdOrderId}/sourcing-plan`, { headers: su })).json();
  expect(sj.sdOrder.planStatus).toBe("confirmed");
  expect(sj.economics).toMatchObject({ revenue: 50000, cost: 36800, margin: 13200, coversAll: true });
});

test("Procurement runs the order to production complete, then signs off QC (and only QC)", async ({ request }) => {
  const pos = (await (await request.get(`/api/admin/orders/${w.orderId}/supplier-pos`, { headers: H(P) })).json()).supplierPos;
  expect(pos.length).toBe(2);
  const stage = (h, s) => request.post(`/api/admin/orders/${w.orderId}/stage`, { headers: h, data: { stage: s } });
  expect((await stage(H(P), "qc_completed")).status()).toBe(409);   // production not finished
  const byCode = {}; for (const k of ["A", "B"]) byCode[k] = SUP[k];
  // each supplier works its own PO
  const mine = async (k) => (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: byCode[k].sh })).json()).purchaseOrders[0].id;
  for (const k of ["A", "B"]) { const id = await mine(k); for (const st of ["accepted", "in_production", "ready_for_qc"]) expect((await spo(request, byCode[k], id, st)).status(), k + st).toBe(200); }
  const my = await (await request.get("/api/admin/my-desk", { headers: H(P) })).json();
  expect(my.items.find(i => i.id === w.sdOrderId).awaiting_qc).toBeGreaterThan(0);
  expect(my.items[0].buy_ceiling).toBe(40);
  // procurement may not push later stages; those belong to the Buyer Desk
  expect((await stage(H(P), "ready_for_transport")).status()).toBe(403);
  // finance cannot bill before QC
  expect((await request.post(`/api/admin/orders/${w.orderId}/invoice`, { headers: H(F), data: { gstRate: 18 } })).status()).toBe(409);
  expect((await stage(H(P), "qc_completed")).status()).toBe(200);
});

test("QC hands the order to Finance and tells the Buyer Desk; Finance releases the invoice to the team", async ({ request }) => {
  const fd = await (await request.get("/api/admin/my-desk", { headers: H(F) })).json();
  expect(fd.desk).toBe("finance");
  expect(fd.toBill.map(o => o.id)).toContain(w.orderId);
  const bd = await (await request.get("/api/admin/my-desk", { headers: H(B) })).json();
  expect(bd.items.find(i => i.id === w.requirementId).deliveryReady).toBe(1);
  const inv = await request.post(`/api/admin/orders/${w.orderId}/invoice`, { headers: H(F), data: { gstRate: 18 } });
  expect(inv.status()).toBe(201);
  const iid = (await inv.json()).invoiceId;
  // not visible to the Buyer Desk or the buyer until released
  expect((await (await request.get(`/api/admin/orders/${w.orderId}/invoice`, { headers: H(B) })).json()).invoices.length).toBe(0);
  expect((await (await request.get("/api/buyer-invoices", { headers: w.b.h })).json()).invoices.length).toBe(0);
  expect((await request.post(`/api/admin/invoices/${iid}/release`, { headers: H(B) })).status()).toBe(403);
  expect((await (await request.get("/api/admin/my-desk", { headers: H(F) })).json()).unreleased.length).toBe(1);
  expect((await request.post(`/api/admin/invoices/${iid}/release`, { headers: H(F) })).status()).toBe(200);
  expect((await (await request.get(`/api/admin/orders/${w.orderId}/invoice`, { headers: H(B) })).json()).invoices.length).toBe(1);
  expect((await (await request.get("/api/buyer-invoices", { headers: w.b.h })).json()).invoices.length).toBe(1);
  // Buyer Desk now takes it to delivery
  for (const k of ["A", "B"]) { const id = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: SUP[k].sh })).json()).purchaseOrders[0].id; for (const st of ["ready_for_dispatch"]) expect((await spo(request, SUP[k], id, st)).status()).toBe(200); }
  const stage = (h, s) => request.post(`/api/admin/orders/${w.orderId}/stage`, { headers: h, data: { stage: s } });
  expect((await stage(H(B), "qc_completed")).status()).toBe(403);
  expect((await stage(H(B), "ready_for_transport")).status()).toBe(200);
  const audits = (await (await request.get("/api/admin/audit", { headers: su })).json()).entries.map(e => e.action);
  for (const a of ["sd_order.ceiling_set", "sd_order.rate_quoted", "sd_order.plan_proposed", "invoice.released"]) expect(audits, a).toContain(a);
});

test("supplier payables: Procurement raises, Management approves, Finance pays - three different hands", async ({ request }) => {
  const poIds = {};
  for (const k of ["A", "B"]) poIds[k] = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: SUP[k].sh })).json()).purchaseOrders[0].id;
  const raise = (h, k, data = {}) => request.post(`/api/admin/supplier-pos/${poIds[k]}/payable`, { headers: h, data });
  expect((await raise(H(B), "A")).status()).toBe(403);                       // Buyer Desk has nothing to do with supplier money
  expect((await raise(H(P), "A", { amount: 99999 })).status()).toBe(409);     // cannot exceed the PO value
  const r = await raise(H(P), "A");
  expect(r.status()).toBe(201); expect((await r.json()).amount).toBe(15200);  // 400 x 38
  expect((await raise(H(P), "A")).status()).toBe(409);                        // one payable per PO
  const pid = (await r.json()).id;
  expect((await request.get("/api/admin/payables", { headers: H(B) })).status()).toBe(403);
  expect((await (await request.get("/api/admin/payables", { headers: H(P) })).json()).payables.length).toBe(1);
  // order matters: approval before payment
  expect((await request.post(`/api/admin/payables/${pid}/pay`, { headers: H(F), data: { reference: "UTR1" } })).status()).toBe(409);
  expect((await request.post(`/api/admin/payables/${pid}/approve`, { headers: H(P) })).status()).toBe(403);
  expect((await request.post(`/api/admin/payables/${pid}/reject`, { headers: H(M), data: {} })).status()).toBe(400);   // a reason is required
  expect((await request.post(`/api/admin/payables/${pid}/approve`, { headers: H(M) })).status()).toBe(200);
  expect((await request.post(`/api/admin/payables/${pid}/pay`, { headers: H(M), data: { reference: "UTR1" } })).status()).toBe(403);   // only Finance pays
  expect((await request.post(`/api/admin/payables/${pid}/pay`, { headers: H(F), data: {} })).status()).toBe(400);
  expect((await request.post(`/api/admin/payables/${pid}/pay`, { headers: H(F), data: { reference: "UTR-" + stamp } })).status()).toBe(200);
  const fin = (await (await request.get("/api/admin/payables?status=paid", { headers: H(F) })).json()).payables[0];
  expect(fin.status).toBe("paid"); expect(fin.paymentRef).toBe("UTR-" + stamp);
  expect(fin.supplier).toMatch(/^Supplier [0-9A-F]{6}$/);                      // Finance pays against an alias, not a name
  // the same person cannot raise and approve (Management raising for B, then approving their own)
  const own = await raise(H(M), "B");
  expect(own.status()).toBe(201);
  const oid = (await own.json()).id;
  const self = await request.post(`/api/admin/payables/${oid}/approve`, { headers: H(M) });
  expect(self.status()).toBe(409); expect((await self.json()).error).toMatch(/segregation/i);
  expect((await request.post(`/api/admin/payables/${oid}/approve`, { headers: su })).status()).toBe(200);   // the owner can step in
});

test("scorecards show speed and saving per person; only Management / Super Admin can read them", async ({ request }) => {
  expect((await request.get("/api/admin/scorecards", { headers: H(P) })).status()).toBe(403);
  expect((await request.get("/api/admin/scorecards", { headers: H(F) })).status()).toBe(403);
  const d = await (await request.get("/api/admin/scorecards", { headers: H(M) })).json();
  const pr = d.procurement.find(x => x.adminId === P.adminId);
  expect(pr).toMatchObject({ assigned: 1, proposed: 1, released: 1 });
  expect(pr.avgSavingPct).toBe(8);               // final rates averaged 36.8 against a buy-below price of 40
  expect(pr.payablesRaised).toBe(1);
  expect(d.finance.find(x => x.adminId === F.adminId)).toMatchObject({ invoices: 1, payablesPaid: 1 });
  expect(d.buyer.find(x => x.adminId === B.adminId).qcDone).toBe(1);
});

test("who did what: Management reads the full trail of the order; desks cannot", async ({ request }) => {
  expect((await request.get(`/api/admin/sd-orders/${w.sdOrderId}/timeline`, { headers: H(P) })).status()).toBe(403);
  const ev = (await (await request.get(`/api/admin/sd-orders/${w.sdOrderId}/timeline`, { headers: H(M) })).json()).events;
  const labels = ev.map(e => e.label);
  for (const l of ["sd order ceiling set", "sd order rate quoted", "sd order plan proposed", "order stage change", "invoice released", "payable raised", "payable paid"]) expect(labels, l).toContain(l);
  expect(ev.find(e => e.label === "sd order plan proposed").by).toBe(P.adminId);
  expect(ev.find(e => e.label === "invoice released").role).toBe("finance");
});

test("UI: Management opens Scorecards; Finance sees payables on My Desk", async ({ page }) => {
  const go = async (u) => { await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [u.token, u.role]); await page.goto("/admin.html"); };
  await go(M);
  await page.locator("#toolsGroup button", { hasText: /^Scorecards$/ }).click();
  await expect(page.locator("#detail h2")).toHaveText("Desk scorecards");
  await expect(page.locator("#detail")).toContainText("Saving %");
  await expect(page.locator("#detail tr", { hasText: /^procurement/ })).toContainText("8");
});
