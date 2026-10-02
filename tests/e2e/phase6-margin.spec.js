const { test, expect } = require("@playwright/test");
const RFQ = require("../../rfq");
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;

test("margin maths (margin is on selling price)", () => {
  expect(RFQ.priceFromMargin(100, 20)).toBe(125);
  expect(RFQ.priceFromMargin(80, 20)).toBe(100);
  expect(RFQ.priceFromMargin(100, 95)).toBeNull();
  expect(RFQ.priceFromMargin(0, 20)).toBeNull();
  expect(RFQ.priceFromMarkup(100, 25)).toBe(125);
  expect(RFQ.priceFromMarkup(0, 25)).toBeNull();
  expect(RFQ.priceFromMarkup(100, 400)).toBeNull();
  expect(RFQ.marginOf(125, 100)).toEqual({ amount: 25, pctOnCost: 25, pctOnPrice: 20 });
});

test.describe("margin is Super Admin only", () => {
  test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and admin env");
  const login = async (request, id, pw) => ({ "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json()).token });
  async function newRfq(request) {
    const email = `p6-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const { requirementId } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "P6", buyerCountry: "India", title: "P6 " + Date.now(), description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "1000", unit: "pcs" } })).json();
    return { requirementId, bh: { "x-buyer-dashboard-token": v.dashboardToken } };
  }

  test("normal admin cannot price by margin or read the margin report", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const { requirementId, bh } = await newRfq(request);
    const base = { quantity: "1000 pcs", costUnitPrice: 100 };
    expect((await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { ...base, marginPct: 20 } })).status()).toBe(403);
    expect((await request.get("/api/super-admin/margin-report", { headers: ah })).status()).toBe(403);
    expect((await request.get("/api/super-admin/margin-report", { headers: bh })).status()).toBeGreaterThanOrEqual(401);
    // admin may still record cost + type a final price
    expect((await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { ...base, unitPrice: 130 } })).status()).toBe(201);
    const view = JSON.stringify(await (await request.get(`/api/buyer-requirements/${requirementId}/quotes`, { headers: bh })).json());
    expect(view).not.toMatch(/cost_unit_price|markup/);
  });

  test("super admin prices by margin on price and sees revenue, cost and margin", async ({ request }) => {
    test.skip(!SID || !SPW, "needs E2E_SUPER_ID/E2E_SUPER_PASSWORD");
    const sa = await login(request, SID, SPW), ah = await login(request, AID, APW);
    const { requirementId, bh } = await newRfq(request);
    const bad = await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: sa, data: { quantity: "1000 pcs", marginPct: 20 } });
    expect(bad.status()).toBe(400);   // cost required
    const q = await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: sa, data: { quantity: "1000 pcs", costUnitPrice: 100, marginPct: 20, unitPrice: 1 } });   // client price ignored
    expect(q.status()).toBe(201);
    expect((await q.json()).total).toBe(125000);
    const { orderId, poNumber } = await (await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: bh, data: { decision: "accept" } })).json().then(async j => ({ orderId: j.orderId, poNumber: j.poNumber }));
    await request.post(`/api/admin/orders/${orderId}/review`, { headers: ah, data: { decision: "accept" } });

    let rep = await (await request.get("/api/super-admin/margin-report", { headers: sa })).json();
    let row = rep.items.find(i => i.id === orderId);
    expect([row.revenue, row.cost, row.margin, row.costSource]).toEqual([125000, 100000, 25000, "quote_estimate"]);
    expect(row.marginPctOnPrice).toBe(20);

    // once a supplier PO exists, its cost wins
    const code = (await (await request.get("/api/products")).json()).products.find(x => x.name === "E2E Test Product").capabilityCode;
    expect((await request.post(`/api/admin/orders/${orderId}/supplier-po`, { headers: ah, data: { capabilityCode: code, quantity: "1000 pcs", unitCost: 90 } })).status()).toBe(201);
    rep = await (await request.get("/api/super-admin/margin-report", { headers: sa })).json();
    row = rep.items.find(i => i.id === orderId);
    expect([row.cost, row.margin, row.costSource]).toEqual([90000, 35000, "supplier_po"]);
    expect(rep.totals.INR.orders).toBeGreaterThan(0);

    // admin audit never carries margin
    const audit = JSON.stringify((await (await request.get(`/api/admin/audit?entity=rfq&id=${requirementId}`, { headers: ah })).json()).entries);
    expect(audit).not.toMatch(/markup|cost_unit|costUnit/i);
  });
});
