const { test, expect } = require("@playwright/test");
// Admin procurement workflow:
// Request -> Review (accept full / partial / reject) -> SupplyDesk order -> Sourcing plan -> Supplier PO.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!KEY || !AID || !APW || !SID || !SPW, "needs admin + super admin env");
test.describe.configure({ mode: "serial" });

const stamp = Date.now();
const sess = {};
const login = async (request, id, pw) => sess[id] || (sess[id] = { token: (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json()).token });
const H = (s) => ({ "x-admin-token": s.token });

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

test.describe("initial review: accept full / partial / reject", () => {
  test("accept partially needs a valid quantity, caps the quote, and auto-creates the SupplyDesk order", async ({ request }) => {
    const ah = H(await login(request, AID, APW)), b = await buyer(request, "pt");
    const id = await newRequirement(request, b, "partial", 1000);
    for (const bad of ["", "0", "1000", "5000", "abc"]) {
      expect((await review(request, ah, id, { action: "accept_partial", acceptedQuantity: bad })).status(), "qty " + bad).toBe(400);
    }
    const ok = await review(request, ah, id, { action: "accept_partial", acceptedQuantity: "600", adminNotes: "internal only", buyerNote: "We can do 600" });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, status: "fulfilling", decision: "partial", acceptedQuantity: "600" });
    // reviewed already: a second decision is a clean conflict-or-ok, never a second supplier-sharing step
    const mine = (await (await request.get("/api/admin/requirements", { headers: ah })).json()).requirements.find(r => r.id === id);
    expect([mine.accept_decision, mine.accepted_quantity, mine.rfq_state]).toEqual(["partial", "600", "costing"]);

    // the quote cannot exceed what SupplyDesk accepted
    expect((await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: ah, data: { unitPrice: 50, quantity: "800 pcs" } })).status()).toBe(400);
    expect((await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: ah, data: { unitPrice: 50, quantity: "600 pcs" } })).status()).toBe(201);

    // buyer accepts the price: the order is already accepted, and its SupplyDesk order exists
    const acc = await (await request.post(`/api/buyer-requirements/${id}/quote/respond`, { headers: b.h, data: { decision: "accept" } })).json();
    const o = (await (await request.get("/api/admin/orders", { headers: ah })).json()).orders.find(x => x.id === acc.orderId);
    expect([o.review_status, o.stage, o.status, o.requested_quantity, o.quantity]).toEqual(["partially_accepted", "supplydesk_accepted", "confirmed", "1000", "600 pcs"]);
    expect(o.sd_order_id).toBeTruthy();
    const bo = (await (await request.get("/api/buyer-orders", { headers: b.h })).json()).orders.find(x => x.id === acc.orderId);
    expect(bo.stageLabel).toBe("SupplyDesk Accepted");
    expect(JSON.stringify(bo)).not.toMatch(/Plan Supplier|supplier_id|SPO-/);
  });

  test("accept in full, reject, and the legacy actions still work", async ({ request }) => {
    const ah = H(await login(request, AID, APW)), b = await buyer(request, "fr");
    const f = await newRequirement(request, b, "full", 500);
    const r1 = await (await review(request, ah, f, { action: "accept_full" })).json();
    expect([r1.status, r1.decision, r1.acceptedQuantity]).toEqual(["fulfilling", "full", null]);
    const x = await newRequirement(request, b, "reject", 500);
    const r2 = await (await review(request, ah, x, { action: "reject", buyerNote: "Out of scope" })).json();
    expect(r2.status).toBe("rejected");
    expect((await review(request, ah, x, { action: "accept_full" })).status()).toBeGreaterThanOrEqual(400);   // already decided
    expect((await review(request, ah, f, { action: "nonsense" })).status()).toBe(400);
    // old API contract is unchanged for existing integrations
    const l = await newRequirement(request, b, "legacy", 500);
    expect((await review(request, ah, l, { action: "supplydesk" })).status()).toBe(200);
    // the buyer sees SupplyDesk wording only
    const mine = (await (await request.get("/api/buyer-requirements", { headers: b.h })).json()).requirements.find(r => r.id === f);
    expect(mine.messages.some(m => /accepted/i.test(m.subject))).toBe(true);
  });

  test("the order review path can also create the SupplyDesk order automatically", async ({ request }) => {
    const ah = H(await login(request, AID, APW)), b = await buyer(request, "ar");
    const id = await newRequirement(request, b, "autoreview", 300);
    await review(request, ah, id, { action: "supplydesk" });                         // legacy path: order will be pending review
    await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: ah, data: { unitPrice: 20, quantity: "300 pcs" } });
    const acc = await (await request.post(`/api/buyer-requirements/${id}/quote/respond`, { headers: b.h, data: { decision: "accept" } })).json();
    let o = (await (await request.get("/api/admin/orders", { headers: ah })).json()).orders.find(x => x.id === acc.orderId);
    expect([o.review_status, o.sd_order_id]).toEqual(["pending_review", null]);
    const r = await (await request.post(`/api/admin/orders/${acc.orderId}/review`, { headers: ah, data: { decision: "accept", autoSdOrder: true } })).json();
    expect(r.sdOrderId).toBeTruthy();
    o = (await (await request.get("/api/admin/orders", { headers: ah })).json()).orders.find(x => x.id === acc.orderId);
    expect(o.sd_order_id).toBe(r.sdOrderId);
    // without the flag nothing is created implicitly (existing consolidation flow keeps working)
    const id2 = await newRequirement(request, b, "noauto", 300);
    await review(request, ah, id2, { action: "supplydesk" });
    await request.post(`/api/admin/requirements/${id2}/buyer-quote`, { headers: ah, data: { unitPrice: 20, quantity: "300 pcs" } });
    const acc2 = await (await request.post(`/api/buyer-requirements/${id2}/quote/respond`, { headers: b.h, data: { decision: "accept" } })).json();
    const r2 = await (await request.post(`/api/admin/orders/${acc2.orderId}/review`, { headers: ah, data: { decision: "accept" } })).json();
    expect(r2.sdOrderId).toBeNull();
  });
});

test.describe("sourcing plan -> internal allocation -> supplier POs", () => {
  let ah, su, A, B, C, ord, b;
  test("eligible capacity per region, recommended allocation, editable draft", async ({ request }) => {
    ah = H(await login(request, AID, APW)); su = H(await login(request, SID, SPW));
    A = await makeSupplier(request, ah, "A", 40000, "Delhi", 10);
    C = await makeSupplier(request, ah, "C", 25000, "Delhi", 12);
    B = await makeSupplier(request, ah, "B", 35000, "Haryana", 14);
    b = await buyer(request, "plan");
    ord = await orderViaFlow(request, ah, b, "plan", 100000);
    expect(ord.sdOrderId).toBeTruthy();

    const p = await (await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: su })).json();
    expect([p.totalRequirement, p.allocated, p.unallocated, p.sdOrder.planStatus]).toEqual([100000, 0, 100000, "planning"]);
    const mine = Object.fromEntries(p.candidates.filter(c => [A, B, C].some(s => s.code === c.capabilityCode)).map(c => [c.capabilityCode, c]));
    expect(Object.keys(mine).length).toBe(3);
    expect([mine[A.code].region, mine[A.code].freeCapacity, mine[C.code].freeCapacity, mine[B.code].region, mine[B.code].freeCapacity]).toEqual(["Delhi", 40000, 25000, "Haryana", 35000]);
    expect(mine[A.code].supplier).toContain("Plan Supplier A");                      // super admin sees names
    // the recommended split never exceeds free capacity or the need, and is one line per supplier
    const rec = p.recommended;
    expect(rec.reduce((t, l) => t + l.quantity, 0)).toBeLessThanOrEqual(100000);
    for (const l of rec) expect(l.quantity).toBeLessThanOrEqual(p.candidates.find(c => c.capabilityCode === l.capabilityCode).freeCapacity);
    expect(new Set(rec.map(l => l.capabilityCode)).size).toBe(rec.length);

    // normal admin: capacity numbers yes, supplier identity no
    const pa = JSON.stringify(await (await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: ah })).json());
    expect(pa).not.toMatch(/Plan Supplier|plan-?a-|@example\.com/i);
    expect(pa).toMatch(/Supplier [0-9A-F]{6}/);
    // not for buyers or suppliers
    expect((await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: b.h })).status()).toBeGreaterThanOrEqual(401);
    expect((await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: A.sh })).status()).toBeGreaterThanOrEqual(401);

    // draft: validated against free capacity and the amount still needed, then saved without contacting anyone
    const put = (lines) => request.put(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: ah, data: { lines } });
    expect((await put([{ capabilityCode: A.code, quantity: 40001 }])).status()).toBe(409);
    expect((await put([{ capabilityCode: "SD-NOPE-0000", quantity: 5 }])).status()).toBe(400);
    expect((await put([{ capabilityCode: A.code, quantity: 10.5 }])).status()).toBe(400);
    expect((await put([{ capabilityCode: A.code, quantity: 100 }, { capabilityCode: A.code, quantity: 100 }])).status()).toBe(400);
    expect((await put([{ capabilityCode: A.code, quantity: 40000 }, { capabilityCode: C.code, quantity: 25000 }, { capabilityCode: B.code, quantity: 35000 }])).status()).toBe(200);
    const again = await (await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: ah })).json();
    expect(again.draft.length).toBe(3);
    expect((await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: A.sh })).json()).purchaseOrders.length).toBe(0);   // nothing sent yet
  });

  test("confirm: shortfall is explicit, POs are SupplyDesk-only, region totals reconcile", async ({ request }) => {
    const confirmUrl = `/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan/confirm`;
    const lines = [{ capabilityCode: A.code, quantity: 40000, unitCost: 30 }, { capabilityCode: C.code, quantity: 25000, unitCost: 31 }, { capabilityCode: B.code, quantity: 35000, unitCost: 32 }];
    expect((await request.post(confirmUrl, { headers: ah, data: { lines: lines.map(l => ({ ...l, unitCost: null })) } })).status()).toBe(400);        // cost required
    expect((await request.post(confirmUrl, { headers: ah, data: { lines: [] } })).status()).toBe(400);
    const short = await request.post(confirmUrl, { headers: ah, data: { lines: lines.slice(0, 2) } });                                            // 65,000 of 100,000
    expect(short.status()).toBe(409);
    expect((await short.json()).code).toBe("shortfall");
    expect((await request.get("/api/supplier-dashboard/purchase-orders", { headers: A.sh })).status()).toBe(200);

    const res = await request.post(confirmUrl, { headers: ah, data: { lines, currency: "INR" } });
    expect(res.status()).toBe(201);
    const done = await res.json();
    expect(done.supplierPos.length).toBe(3);
    expect((await request.post(confirmUrl, { headers: ah, data: { lines } })).status()).toBeGreaterThanOrEqual(400);            // nothing left to allocate / duplicate suppliers

    // internal allocation reconciles: Delhi A 40,000 + Delhi C 25,000 = 65,000, Haryana B 35,000, total 100,000
    const al = await (await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/allocation`, { headers: su })).json();
    expect([al.totalRequirement, al.allocated, al.unallocated]).toEqual([100000, 100000, 0]);
    const reg = Object.fromEntries(al.regions.map(r => [r.region, r]));
    expect([reg.Delhi.total, reg.Haryana.total]).toEqual([65000, 35000]);
    expect(reg.Delhi.suppliers.map(s => s.quantity).sort()).toEqual([25000, 40000]);

    // the plan is now "Planned"; the SD list says so
    const sd = (await (await request.get("/api/admin/sd-orders", { headers: ah })).json()).sdOrders.find(s => s.id === ord.sdOrderId);
    expect([sd.plan_status, sd.needed, sd.allocated]).toEqual(["confirmed", 100000, 100000]);
    const after = await (await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: ah })).json();
    expect([after.unallocated, after.sdOrder.planStatus]).toEqual([0, "confirmed"]);

    // supplier view: a SupplyDesk PO, never the buyer
    for (const [s, qty] of [[A, "40000"], [C, "25000"], [B, "35000"]]) {
      const po = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: s.sh })).json()).purchaseOrders[0];
      expect([po.quantity, po.statusLabel]).toEqual([qty, "SupplyDesk PO"]);
      expect(JSON.stringify(po)).not.toMatch(/Secret Buyer|@example\.com|buyer|99\.5|Pune|50\.0000/i);
      expect(JSON.stringify(po)).not.toContain(ord.poNumber);
    }
    // buyer sees SupplyDesk status only
    const bo = (await (await request.get("/api/buyer-orders", { headers: b.h })).json()).orders.find(x => x.id === ord.orderId);
    expect(JSON.stringify(bo)).not.toMatch(/Plan Supplier|SPO-|supplier_id/);
    expect(bo.stageLabel).toBe("SupplyDesk Accepted");
  });

  test("a supplier that declines reopens the plan and shows up as an exception; pipeline counts are consistent", async ({ request }) => {
    const sup = (h, id, status, data = {}) => request.patch(`/api/supplier-dashboard/purchase-orders/${id}/status`, { headers: h, data: { status, ...data } });
    const poOf = async (s) => (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: s.sh })).json()).purchaseOrders[0].id;
    expect((await sup(A.sh, await poOf(A), "accepted")).status()).toBe(200);
    expect((await sup(B.sh, await poOf(B), "declined", { note: "Line down" })).status()).toBe(200);

    const plan = await (await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: ah })).json();
    expect(plan.unallocated).toBe(35000);                                           // Haryana share is open again
    expect(plan.candidates.find(c => c.capabilityCode === B.code)?.hasLivePo).toBe(false);
    const ex = (await (await request.get("/api/admin/exceptions", { headers: ah })).json()).exceptions;
    expect(ex.some(e => e.type === "po_declined" && e.id === ord.sdOrderId)).toBe(true);

    const pipe = await (await request.get("/api/admin/pipeline", { headers: ah })).json();
    expect(pipe.stages.map(s => s.key)).toEqual(["new_requests", "review", "accepted", "sourcing", "supplier_po", "production", "qc", "transit", "delivery"]);
    expect(pipe.stages.map(s => s.label)).toEqual(["New Requests", "Review", "Accepted", "Sourcing", "Supplier PO", "Production", "QC", "Transit", "Delivery"]);
    for (const s of pipe.stages) expect(Number.isInteger(s.count) && s.count >= 0).toBe(true);
    expect(pipe.stages.find(s => s.key === "supplier_po").count).toBeGreaterThanOrEqual(1);   // C's PO still awaits acceptance
    expect(pipe.stages.find(s => s.key === "production").count).toBeGreaterThanOrEqual(1);    // A accepted
    expect(pipe.exceptions).toBeGreaterThanOrEqual(1);

    // re-plan the remaining 35,000 with the supplier that still has room (Haryana B is free again)
    const re = await request.post(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan/confirm`, { headers: ah, data: { lines: [{ capabilityCode: B.code, quantity: 35000, unitCost: 33 }] } });
    expect(re.status()).toBe(201);
    expect((await (await request.get(`/api/admin/sd-orders/${ord.sdOrderId}/sourcing-plan`, { headers: ah })).json()).unallocated).toBe(0);
  });

  test("pipeline, exceptions, capacity and agreements are admin-only", async ({ request }) => {
    for (const u of ["/api/admin/pipeline", "/api/admin/exceptions", "/api/admin/capacity", "/api/admin/agreements"]) {
      expect((await request.get(u)).status(), u).toBeGreaterThanOrEqual(401);
      expect((await request.get(u, { headers: A.sh })).status(), u + " supplier").toBeGreaterThanOrEqual(401);
      expect((await request.get(u, { headers: b.h })).status(), u + " buyer").toBeGreaterThanOrEqual(401);
      expect((await request.get(u, { headers: ah })).status(), u + " admin").toBe(200);
    }
    const cap = (await (await request.get("/api/admin/capacity", { headers: ah })).json()).items.find(i => i.capabilityCode === C.code);
    expect([cap.installed, cap.available, cap.allocated, cap.committed, cap.free, cap.capacityVerified]).toEqual([50000, 25000, 25000, 0, 0, true]);
    expect(JSON.stringify(cap)).not.toContain("Plan Supplier");                       // alias for normal admin
    const ag = (await (await request.get("/api/admin/agreements", { headers: su })).json()).items.find(i => i.supplier.includes("Plan Supplier A"));
    expect([ag.onboardingStatus, ag.eligible, !!ag.agreementSignedAt]).toEqual(["supplydesk_approved", true, true]);
  });
});

test.describe("admin UI follows the new flow", () => {
  async function openAdmin(request, page) {
    const login = await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json();
    await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [login.token, login.role]);
    await page.goto("/admin.html");
  }

  test("navigation: Overview, Requests, Sourcing, Orders, Production, QC, Logistics, Finance, Exceptions + separate supplier network", async ({ request, page }) => {
    await openAdmin(request, page);
    const names = async (sel) => (await page.locator(sel + " button:visible").allTextContents()).map(t => t.replace(/\d+$/, "").trim());
    expect(await names("#opsGroup")).toEqual(["Overview", "Requests", "Sourcing", "Orders", "Production", "QC", "Logistics", "Finance", "Exceptions"]);
    expect(await names("#networkGroup")).toEqual(["Products", "Capabilities", "Capacity", "Verification", "Agreements"]);
    // pipeline dashboard
    await expect(page.locator(".pl-stage")).toHaveCount(9);
    await expect(page.locator(".pl-stage span")).toHaveText(["New Requests", "Review", "Accepted", "Sourcing", "Supplier PO", "Production", "QC", "Transit", "Delivery"]);
    // every screen opens without an error message
    for (const [btn, heading] of [["Sourcing", /Sourcing plans/], ["Production", /Production/], ["QC", /QC/], ["Logistics", /Logistics/], ["Finance", /Finance/]]) {
      await page.locator("#opsGroup button", { hasText: new RegExp("^" + btn + "$") }).click();
      await expect(page.locator("#list")).toContainText(heading);
      await expect(page.locator("#message")).toHaveText("");
    }
    await page.locator("#opsGroup button", { hasText: /^Exceptions/ }).click();
    await expect(page.locator("#detail h2")).toHaveText("Exceptions");
    await page.locator("#networkGroup button", { hasText: "Capacity" }).click();
    await expect(page.locator("#detail h2")).toHaveText("Capacity");
    await expect(page.locator(".nt-t")).toBeVisible();
    await page.locator("#networkGroup button", { hasText: "Agreements" }).click();
    await expect(page.locator("#detail h2")).toHaveText("Agreements");
    await page.locator("#networkGroup button", { hasText: "Capabilities" }).click();
    await expect(page.locator("#detail h2")).toHaveText("Capabilities");
  });

  test("sourcing plan screen: recommended allocation is editable, totals update, confirm issues SupplyDesk POs", async ({ request, page }) => {
    const ah = H(await login(request, AID, APW));
    const S = await makeSupplier(request, ah, "UI1", 3000, "Delhi", 5);
    const T = await makeSupplier(request, ah, "UI2", 2000, "Haryana", 7);
    const bb = await buyer(request, "ui");
    const o = await orderViaFlow(request, ah, bb, "uiplan", 4500);
    await openAdmin(request, page);
    page.on("dialog", d => d.accept());
    await page.locator("#opsGroup button", { hasText: /^Sourcing$/ }).click();
    await page.locator(".rq-row", { hasText: `AW uiplan ${stamp}` }).click();
    const d = page.locator("#detail");
    await expect(d.locator(".sp-sum")).toContainText("4,500");
    await expect(d.locator(`.sp-q[data-code="${S.code}"]`)).toBeVisible();
    await expect(d.locator(`.sp-q[data-code="${T.code}"]`)).toBeVisible();
    await expect(d.locator(".sp-lock")).toContainText("SUPPLYDESK");
    // clear, then edit by hand: totals follow
    await d.getByRole("button", { name: "Clear" }).click();
    await expect(d.locator("#spTot")).toContainText("Total = 0");
    await d.locator(`.sp-q[data-code="${S.code}"]`).fill("2500");
    await d.locator(`.sp-q[data-code="${T.code}"]`).fill("2000");
    await expect(d.locator("#spTot")).toContainText("Total = 4,500");
    await expect(d.locator("#spTot")).toHaveClass(/ok/);
    await d.locator(`.sp-q[data-code="${T.code}"]`).fill("2500");                                   // over the 2,000 free
    await expect(d.locator("#spTot")).toHaveClass(/bad/);
    await d.locator(`.sp-q[data-code="${T.code}"]`).fill("2000");
    // cost is required for every line
    await d.getByRole("button", { name: /Confirm allocation/ }).click();
    await expect(page.locator("#message")).toContainText("unit cost");
    await d.locator(`.sp-c[data-code="${S.code}"]`).fill("10");
    await d.locator(`.sp-c[data-code="${T.code}"]`).fill("11");
    await d.getByRole("button", { name: /Confirm allocation/ }).click();
    await expect(page.locator("#message")).toContainText("Supplier PO(s) issued");
    await expect(d.locator(".rq-q", { hasText: "Customer on PO: SUPPLYDESK" })).toHaveCount(2);
    await expect(d.locator(".sp-q")).toHaveCount(0);                                                // nothing left to allocate: no editor
    await expect(d.locator(".rq-pill")).toHaveText("Planned");
    // the supplier got a PO from SupplyDesk
    const po = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: S.sh })).json()).purchaseOrders[0];
    expect([po.quantity, po.statusLabel]).toEqual(["2500", "SupplyDesk PO"]);
  });
});
