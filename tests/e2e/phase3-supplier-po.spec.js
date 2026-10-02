const { test, expect } = require("@playwright/test");
const RFQ = require("../../rfq");
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;

test("supplier PO state rules", () => {
  expect(RFQ.canPoTransition("issued", "accepted")).toBe(true);
  expect(RFQ.canPoTransition("issued", "completed")).toBe(false);
  expect(RFQ.canPoTransition("declined", "accepted")).toBe(false);
  expect(RFQ.newSupplierPoNumber()).toMatch(/^SPO-\d{6}-[A-Z0-9]{4}$/);
});

test.describe("SupplyDesk issues a PO to the supplier", () => {
  test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and admin env");

  async function makeOrder(request, ah) {
    const email = `p3-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const bh = { "x-buyer-dashboard-token": v.dashboardToken };
    const { requirementId } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "Secret Buyer Co", buyerCompany: "Secret Buyer Co", buyerCountry: "India", title: "P3 " + Date.now(), description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "1000", unit: "pcs" } })).json();
    await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: 50, quantity: "1000 pcs" } });
    const acc = await (await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: bh, data: { decision: "accept" } })).json();
    return { orderId: acc.orderId, email, bh };
  }
  async function supplierHeaders(request) {
    const email = "supplier-e2e@example.com";
    const r = await (await request.post("/api/supplier-dashboard/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/supplier-dashboard/verify-otp", { data: { email, otp: r.testOtp } })).json();
    return { "x-supplier-dashboard-token": v.token };
  }

  test("issue -> supplier accepts -> production -> dispatch -> complete, with privacy and permissions", async ({ request }) => {
    const ah = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json()).token };
    const { orderId, bh } = await makeOrder(request, ah);
    const orderStatus = async () => (await (await request.get("/api/buyer-orders", { headers: bh })).json()).orders[0].status;
    const sh = await supplierHeaders(request);
    const { products } = await (await request.get("/api/products")).json();
    const code = products.find(x => x.name === "E2E Test Product").capabilityCode;

    // validation + auth
    expect((await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: sh, data: { capabilityCode: code, quantity: "1000", unitCost: 30 } })).status()).toBeGreaterThanOrEqual(401);
    expect((await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { capabilityCode: code, quantity: "1000", unitCost: 0 } })).status()).toBe(400);
    expect((await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { capabilityCode: "SD-NOP-0000", quantity: "1000", unitCost: 30 } })).status()).toBe(404);
    expect((await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { supplierId: "x", quantity: "1000", unitCost: 30 } })).status()).toBe(400); // normal admin cannot pick by supplier id

    const issued = await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { capabilityCode: code, quantity: "1000 pcs", unitCost: 30, deliveryBy: "2030-01-01", terms: "net 30" } });
    expect(issued.status()).toBe(201);
    const { poNumber, supplierPoId } = await issued.json();
    expect(poNumber).toMatch(/^SPO-/);
    expect((await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { capabilityCode: code, quantity: "1000", unitCost: 30 } })).status()).toBe(409); // duplicate active PO

    // supplier sees the PO but nothing about the buyer or the buyer price
    const list = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).json()).purchaseOrders;
    const mine = list.find(p => p.id === supplierPoId);
    expect(mine.status).toBe("issued");
    expect(JSON.stringify(mine)).not.toMatch(/Secret Buyer|50\.0000|@example\.com|buyer/i);
    expect((await request.get("/api/supplier-dashboard/purchase-orders")).status()).toBe(401);

    // illegal moves, decline needs reason, then the happy path
    expect((await request.patch(`/api/supplier-dashboard/purchase-orders/${supplierPoId}/status`, { headers: sh, data: { status: "completed" } })).status()).toBe(409);
    expect((await request.patch(`/api/supplier-dashboard/purchase-orders/${supplierPoId}/status`, { headers: sh, data: { status: "declined" } })).status()).toBe(400);
    const expectedOrder = { accepted: "confirmed", in_production: "in_production", dispatched: "shipped", completed: "shipped" };
    for (const s of ["accepted", "in_production", "dispatched", "completed"]) {
      expect((await request.patch(`/api/supplier-dashboard/purchase-orders/${supplierPoId}/status`, { headers: sh, data: { status: s, note: "ok" } })).status()).toBe(200);
      expect(await orderStatus(), "buyer order after PO " + s).toBe(expectedOrder[s]);   // buyer order follows supplier progress
    }
    expect((await request.patch(`/api/admin/supplier-pos/${supplierPoId}/cancel`, { headers: ah, data: {} })).status()).toBe(409); // completed cannot be cancelled

    // admin sees the PO with alias only
    const adminView = (await (await request.get(`/api/admin/orders/${orderId}/supplier-pos`, { headers: ah })).json()).supplierPos;
    expect(adminView[0].status).toBe("completed");
    expect(JSON.stringify(adminView)).not.toMatch(/India Growth|supplier-e2e@example\.com/);

    const audit = (await (await request.get(`/api/admin/audit?entity=supplier_po&id=${supplierPoId}`, { headers: ah })).json()).entries.map(a => a.action);
    expect(audit).toContain("supplier_po.issued");
    expect(audit).toContain("supplier_po.status_change");
  });

  test("admin can cancel an issued PO; declined PO frees the supplier for a new one; super admin sees supplier name", async ({ request }) => {
    const ah = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json()).token };
    const { orderId } = await makeOrder(request, ah);
    const sh = await supplierHeaders(request);
    const code = (await (await request.get("/api/products")).json()).products.find(x => x.name === "E2E Test Product").capabilityCode;
    const a = await (await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { capabilityCode: code, quantity: "500", unitCost: 31 } })).json();
    expect((await request.patch(`/api/supplier-dashboard/purchase-orders/${a.supplierPoId}/status`, { headers: sh, data: { status: "declined", note: "no capacity" } })).status()).toBe(200);
    const b = await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { capabilityCode: code, quantity: "500", unitCost: 32 } });
    expect(b.status()).toBe(201);
    const { supplierPoId } = await b.json();
    expect((await request.patch(`/api/admin/supplier-pos/${supplierPoId}/cancel`, { headers: ah, data: { note: "changed plan" } })).status()).toBe(200);
    const sup = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).json()).purchaseOrders.find(p => p.id === supplierPoId);
    expect(sup.status).toBe("cancelled");
    expect((await request.patch(`/api/supplier-dashboard/purchase-orders/${supplierPoId}/status`, { headers: sh, data: { status: "accepted" } })).status()).toBe(409);
    if (SID && SPW) {
      const sa = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: SID, password: SPW } })).json()).token };
      const rows = (await (await request.get(`/api/admin/orders/${orderId}/supplier-pos`, { headers: sa })).json()).supplierPos;
      expect(JSON.stringify(rows)).toMatch(/India Growth/);
    }
  });
});
