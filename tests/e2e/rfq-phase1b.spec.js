const { test, expect } = require("@playwright/test");
const RFQ = require("../../rfq");
// Phase 1B: structured RFQ, state machine, audit log, capability matching, procurement queue.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;

test("state machine allows the happy path and rejects illegal jumps", () => {
  expect(RFQ.canTransition("submitted", "sourcing")).toBe(true);
  expect(RFQ.canTransition("sourcing", "quotes_received")).toBe(true);
  expect(RFQ.canTransition("quote_sent", "buyer_approved")).toBe(true);
  expect(RFQ.canTransition("submitted", "converted")).toBe(false);
  expect(RFQ.canTransition("cancelled", "sourcing")).toBe(false);
  expect(RFQ.isTerminal("cancelled")).toBe(true);
  expect(RFQ.newRfqCode()).toMatch(/^RFQ-\d{6}-[A-Z0-9]{4}$/);
  expect(RFQ.parseQuantity("2 lakh")).toBe(200000);
});

test("capability scoring prefers a category match with enough free capacity", () => {
  const rfq = { category: "Plastics & Polymers", subcategory: "Containers", quantity: "10,000", title: "container" };
  const good = RFQ.scoreCapability(rfq, { category: "Plastics & Polymers", subcategory: "Containers", available_capacity: 50000, monthly_capacity: 100000, capacity_updated_at: new Date(), lead_time_days: 14 });
  const other = RFQ.scoreCapability(rfq, { category: "Textiles", subcategory: "Fabric", available_capacity: 50000, monthly_capacity: 100000, capacity_updated_at: new Date() });
  expect(good.score).toBeGreaterThan(other.score);
  expect(good.coversFull).toBe(true);
});

test.describe("RFQ lifecycle with audit trail", () => {
  test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and E2E_ADMIN_ID/E2E_ADMIN_PASSWORD");

  test("create → queue → matches → state moves → audit; buyer cannot use admin endpoints", async ({ request }) => {
    const email = `rfq-${Date.now()}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const bh = { "x-buyer-dashboard-token": v.dashboardToken };
    const sub = await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "RFQ Buyer", buyerCountry: "India", title: "RFQ " + Date.now(), description: "Need containers", specification: "500ml PP", certifications: "BIS", packaging: "carton", paymentTerms: "30% advance", incoterm: "FOB", category: "Plastics & Polymers", subcategory: "Containers", quantity: "10000", unit: "pcs", requiredBy: "2030-01-01" } });
    expect(sub.status()).toBe(201);
    const { requirementId, rfqCode } = await sub.json();
    expect(rfqCode).toMatch(/^RFQ-\d{6}-[A-Z0-9]{4}$/);

    const mine = (await (await request.get("/api/buyer-requirements", { headers: bh })).json()).requirements.find(r => r.id === requirementId);
    expect(mine.rfq_code).toBe(rfqCode);
    expect(mine.rfq_state).toBe("submitted");
    expect(mine.stateLabel).toBeTruthy();

    // buyer must not reach admin endpoints
    for (const u of ["/api/admin/procurement/queue", `/api/admin/requirements/${requirementId}/capability-matches`, "/api/admin/audit"]) {
      expect((await request.get(u, { headers: bh })).status()).toBeGreaterThanOrEqual(401);
    }
    expect((await request.post(`/api/admin/requirements/${requirementId}/state`, { headers: bh, data: { state: "sourcing" } })).status()).toBeGreaterThanOrEqual(401);

    const login = await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json();
    const ah = { "x-admin-token": login.token };

    const q = await (await request.get("/api/admin/procurement/queue", { headers: ah })).json();
    expect(q.items.find(i => i.id === requirementId).rfq_state).toBe("submitted");
    expect(q.counts.submitted).toBeGreaterThan(0);

    const m = await (await request.get(`/api/admin/requirements/${requirementId}/capability-matches`, { headers: ah })).json();
    expect(m.matches.length).toBeGreaterThan(0);
    expect(m.matches[0].capabilityCode).toMatch(/^SD-/);

    // illegal jump -> 409, unknown state -> 400, legal moves ok
    expect((await request.post(`/api/admin/requirements/${requirementId}/state`, { headers: ah, data: { state: "converted" } })).status()).toBe(409);
    expect((await request.post(`/api/admin/requirements/${requirementId}/state`, { headers: ah, data: { state: "nonsense" } })).status()).toBe(400);
    expect((await request.post(`/api/admin/requirements/${requirementId}/state`, { headers: ah, data: { state: "sourcing", note: "go" } })).status()).toBe(200);

    const audit = (await (await request.get(`/api/admin/audit?entity=rfq&id=${requirementId}`, { headers: ah })).json()).entries;
    const actions = audit.map(a => a.action);
    expect(actions).toContain("rfq.created");
    expect(actions.some(a => /state/.test(a))).toBe(true);

    // buyer cancel goes through the state machine
    expect((await request.patch("/api/buyer-requirements/" + requirementId, { headers: bh, data: { status: "cancelled" } })).status()).toBe(200);
    const after = (await (await request.get("/api/buyer-requirements", { headers: bh })).json()).requirements.find(r => r.id === requirementId);
    expect(after.rfq_state).toBe("cancelled");
    expect((await request.post(`/api/admin/requirements/${requirementId}/state`, { headers: ah, data: { state: "sourcing" } })).status()).toBe(409);
  });
});
