const { test, expect } = require("@playwright/test");
const RFQ = require("../../rfq");
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;

test("order state rules", () => {
  expect(RFQ.canOrderTransition("confirmed", "in_production")).toBe(true);
  expect(RFQ.canOrderTransition("confirmed", "delivered")).toBe(false);
  expect(RFQ.canOrderTransition("delivered", "cancelled")).toBe(false);
  expect(RFQ.newPoNumber()).toMatch(/^PO-\d{6}-[A-Z0-9]{4}$/);
});

test.describe("SupplyDesk quote -> buyer accepts -> order", () => {
  test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and admin env");

  async function newBuyer(request) {
    const email = `p2-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    return { bh: { "x-buyer-dashboard-token": v.dashboardToken }, token: v.dashboardToken };
  }
  const post = (request, buyer, title) => request.post("/api/buyer-requirements", { data: { dashboardToken: buyer.token, buyerName: "P2", buyerCountry: "India", title, description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "1000", unit: "pcs" } });

  test("full commercial flow with permissions and illegal moves", async ({ request }) => {
    const buyer = await newBuyer(request), other = await newBuyer(request);
    const { requirementId } = await (await post(request, buyer, "P2 " + Date.now())).json();
    const login = await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json();
    const ah = { "x-admin-token": login.token };

    // validation + auth
    expect((await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: buyer.bh, data: { unitPrice: 10, quantity: "1000" } })).status()).toBeGreaterThanOrEqual(401);
    expect((await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: 0, quantity: "1000" } })).status()).toBe(400);
    expect((await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: buyer.bh, data: { decision: "accept" } })).status()).toBe(409); // nothing sent yet

    const q = await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: 12.5, currency: "INR", quantity: "1000 pcs", leadTimeDays: 20, terms: "30% advance" } });
    expect(q.status()).toBe(201);
    const qj = await q.json();
    expect(qj.quoteNo).toMatch(/^SQ-\d{6}-[A-Z0-9]{4}$/);
    expect(qj.total).toBe(12500);

    // buyer sees only the SupplyDesk quote
    const view = await (await request.get(`/api/buyer-requirements/${requirementId}/quotes`, { headers: buyer.bh })).json();
    expect(view.quotes).toEqual([]);
    expect(view.sdQuotes[0].quote_no).toBe(qj.quoteNo);
    expect(JSON.stringify(view)).not.toMatch(/India Growth|supplier/i);

    // another buyer cannot respond; admin cannot respond as buyer
    expect((await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: other.bh, data: { decision: "accept" } })).status()).toBe(404);
    expect((await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: buyer.bh, data: { decision: "maybe" } })).status()).toBe(400);

    const acc = await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: buyer.bh, data: { decision: "accept", note: "go ahead" } });
    expect(acc.status()).toBe(201);
    const { poNumber, orderId } = await acc.json();
    expect(poNumber).toMatch(/^PO-/);
    // cannot accept twice (no open quote)
    expect((await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: buyer.bh, data: { decision: "accept" } })).status()).toBe(409);

    const mine = (await (await request.get("/api/buyer-orders", { headers: buyer.bh })).json()).orders;
    expect(mine.map(o => o.po_number)).toContain(poNumber);
    expect((await (await request.get("/api/buyer-orders", { headers: other.bh })).json()).orders.length).toBe(0);
    const rq = (await (await request.get("/api/buyer-requirements", { headers: buyer.bh })).json()).requirements.find(r => r.id === requirementId);
    expect(rq.rfq_state).toBe("converted");

    // a new order starts as Pending Review; progress is no longer set by hand through the coarse status endpoint
    expect(mine.find(o => o.id === orderId).reviewStatus).toBe("pending_review");
    expect((await request.patch(`/api/admin/orders/${orderId}/status`, { headers: buyer.bh, data: { status: "shipped" } })).status()).toBeGreaterThanOrEqual(401);
    for (const s of ["in_production", "shipped", "delivered"]) expect((await request.patch(`/api/admin/orders/${orderId}/status`, { headers: ah, data: { status: s } })).status()).toBe(409);
    expect((await request.patch(`/api/admin/orders/${orderId}/status`, { headers: ah, data: { status: "cancelled" } })).status()).toBe(200);
    expect((await request.patch(`/api/admin/orders/${orderId}/status`, { headers: ah, data: { status: "in_production" } })).status()).toBe(409);
    expect((await (await request.get("/api/buyer-orders", { headers: buyer.bh })).json()).orders[0].status).toBe("cancelled");

    const audit = (await (await request.get(`/api/admin/audit?entity=order&id=${orderId}`, { headers: ah })).json()).entries.map(a => a.action);
    expect(audit).toContain("order.created");
    expect(audit).toContain("order.status_change");
    expect((await (await request.get("/api/admin/orders", { headers: ah })).json()).orders.some(o => o.po_number === poNumber)).toBe(true);
  });

  test("buyer can decline a quote; expired quotes cannot be accepted; revised quote supersedes", async ({ request }) => {
    const buyer = await newBuyer(request);
    const { requirementId } = await (await post(request, buyer, "P2b " + Date.now())).json();
    const ah = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json()).token };
    const send = (price) => request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: price, quantity: "1000" } });
    expect((await send(20)).status()).toBe(201);
    expect((await send(18)).status()).toBe(201);   // revision supersedes the first
    const v = await (await request.get(`/api/buyer-requirements/${requirementId}/quotes`, { headers: buyer.bh })).json();
    expect(v.sdQuotes.length).toBe(1);
    expect(Number(v.sdQuotes[0].unit_price)).toBe(18);
    expect((await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: buyer.bh, data: { decision: "reject", note: "too high" } })).status()).toBe(200);
    const rq = (await (await request.get("/api/buyer-requirements", { headers: buyer.bh })).json()).requirements.find(r => r.id === requirementId);
    expect(rq.rfq_state).toBe("lost");
    expect((await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: buyer.bh, data: { decision: "accept" } })).status()).toBe(409);
  });
});
