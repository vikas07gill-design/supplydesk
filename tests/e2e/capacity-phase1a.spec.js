const { test, expect } = require("@playwright/test");
// Phase 1A: product + capacity is public, supplier identity is not; SupplyDesk decides each quote request.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;

test("public product shows capacity band, status, lead time and capability ID but no supplier identity", async ({ request }) => {
  const { products } = await (await request.get("/api/products")).json();
  const p = products.find(x => x.name === "E2E Test Product");
  expect(p, "seeded product visible").toBeTruthy();
  expect(p.capabilityCode).toMatch(/^SD-[A-Z0-9]{3}-[A-Z0-9]{4}$/);
  expect(p.capacity.band).toBe("100,000 - 500,000");   // exact 120,000 is never shown
  expect(p.capacity.status).toBe("available");
  expect(p.capacity.leadTimeDays).toBe(21);
  const detail = await (await request.get("/api/products/" + p.id)).json();
  expect(JSON.stringify(detail)).not.toMatch(/120000|80000|India Growth|website|supplierId/i);
  // searching by the supplier's name must not find the product
  const byName = await (await request.get("/api/products?q=" + encodeURIComponent("India Growth"))).json();
  expect(byName.products.length).toBe(0);
});

test("product page renders the capacity panel and quote request, not a supplier link", async ({ page }) => {
  const { products } = await (await page.request.get("/api/products")).json();
  const p = products.find(x => x.name === "E2E Test Product");
  await page.goto("/product.html?id=" + p.id);
  await expect(page.locator("#capGrid")).toContainText("100,000 - 500,000");
  await expect(page.locator("#capCode")).toContainText(p.capabilityCode);
  await expect(page.locator("#connectBtn")).toHaveText(/Request Quote/);
  await expect(page.locator("body")).not.toContainText("View Supplier");
});

test.describe("SupplyDesk decides a quote request against capacity", () => {
  test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and E2E_ADMIN_ID/E2E_ADMIN_PASSWORD");

  test("partial acceptance with remarks reaches the buyer, supplier never sees the buyer", async ({ request }) => {
    const { products } = await (await request.get("/api/products")).json();
    const p = products.find(x => x.name === "E2E Test Product");
    const email = `cap-${Date.now()}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const bh = { "x-buyer-dashboard-token": v.dashboardToken };
    const sent = await request.post("/api/connect-requests", { headers: { "x-e2e-key": KEY }, data: { productId: p.id, customerName: "Cap Buyer", customerEmail: email, quantity: "1000 pcs", dashboardToken: v.dashboardToken } });
    expect(sent.status()).toBe(201);
    const { enquiryId } = await sent.json();

    // buyer sees "pending" and no supplier fields
    let dash = await (await request.get("/api/buyer-dashboard", { headers: bh })).json();
    let row = dash.enquiries.find(e => e.id === enquiryId);
    expect(row.decision).toBe("pending");
    expect(JSON.stringify(row)).not.toMatch(/supplierId|supplierName|India Growth/i);

    const login = await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json();
    const ah = { "x-admin-token": login.token };
    const reqs = (await (await request.get("/api/admin/connect-requests", { headers: ah })).json()).requests;
    const mine = reqs.find(r => r.enquiry_id === enquiryId);
    expect(mine.capability_code).toBe(p.capabilityCode);
    expect(mine.capacity_band).toBe("50,000 - 100,000");   // normal admin sees the band only; exact capacity is Super Admin only

    // permissions + validation
    expect((await request.post(`/api/admin/connect-requests/${mine.id}/decision`, { headers: bh, data: { decision: "accepted" } })).status()).toBeGreaterThanOrEqual(401);
    expect((await request.post(`/api/admin/connect-requests/${mine.id}/decision`, { headers: ah, data: { decision: "partial", remark: "x" } })).status()).toBe(400);   // quantity needed
    expect((await request.post(`/api/admin/connect-requests/${mine.id}/decision`, { headers: ah, data: { decision: "rejected" } })).status()).toBe(400);              // remark needed

    const ok = await request.post(`/api/admin/connect-requests/${mine.id}/decision`, { headers: ah, data: { decision: "partial", approved_quantity: "500 pcs", remark: "Only 500 pcs free this month." } });
    expect(ok.status()).toBe(200);
    dash = await (await request.get("/api/buyer-dashboard", { headers: bh })).json();
    row = dash.enquiries.find(e => e.id === enquiryId);
    expect(row.decision).toBe("partial");
    expect(row.approvedQuantity).toBe("500 pcs");
    expect(row.remark).toBe("Only 500 pcs free this month.");
  });
});
