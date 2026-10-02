const { test, expect } = require("@playwright/test");
// Admin messages and quote details must be visible to the buyer in the dashboard (not only by email).
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
test.skip(!KEY || !AID || !APW, "needs E2E env");

test("admin message + quote + order updates appear on buyer dashboard", async ({ request, page }) => {
  const email = `bu-${Date.now()}@example.com`;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  const bh = { "x-buyer-dashboard-token": v.dashboardToken };
  const title = "Updates " + Date.now();
  const { requirementId: id } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "Upd Buyer", buyerCountry: "India", title, description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "1000 pcs", deliveryCountry: "India" } })).json();
  // a second requirement guards the multi-row IN() lookup
  await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "Upd Buyer", buyerCountry: "India", title: "Second " + Date.now(), description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "5 pcs", deliveryCountry: "India" } });
  const ah = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json()).token };

  // buyer cannot use admin message endpoint; empty message rejected
  expect((await request.post(`/api/admin/requirements/${id}/message`, { headers: bh, data: { message: "x" } })).status()).toBeGreaterThanOrEqual(401);
  expect((await request.post(`/api/admin/requirements/${id}/message`, { headers: ah, data: { message: "  " } })).status()).toBe(400);
  expect((await request.post(`/api/admin/requirements/${id}/message`, { headers: ah, data: { subject: "Need drawings", message: "Please share the drawing for " + title } })).status()).toBe(201);

  let list = (await (await request.get("/api/buyer-requirements", { headers: bh })).json()).requirements.find(r => r.id === id);
  expect(list.messages[0].subject).toBe("Need drawings");
  expect(list.stateStep).toBe(1);
  expect(list.openQuote).toBeNull();

  // quote -> openQuote + message
  expect((await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: ah, data: { unitPrice: 25, quantity: "1000 pcs", leadTimeDays: 12, note: "Ex-works price" } })).status()).toBe(201);
  list = (await (await request.get("/api/buyer-requirements", { headers: bh })).json()).requirements.find(r => r.id === id);
  expect(list.stateStep).toBe(3);
  expect(Number(list.openQuote.unit_price)).toBe(25);
  expect(list.messages[0].subject).toMatch(/^Quotation SQ-/);
  expect(JSON.stringify(list)).not.toMatch(/cost_unit_price|markup/);

  // dashboard UI shows quote box, tracker and updates feed
  await page.addInitScript(t => localStorage.setItem("supplydesk_buyer_dashboard_token", t), v.dashboardToken);
  await page.goto("/buyer-dashboard.html");
  const card = page.locator(".rq", { hasText: title });
  await expect(card.locator(".qbox")).toContainText("25.00 INR");
  await expect(card.locator(".upd")).toContainText("Need drawings");
  await expect(page.locator("#awaiting")).toHaveText("1");
  await expect(page.locator("#total")).toHaveText("2");

  // accept in UI -> order + order message
  page.on("dialog", d => d.accept());
  await card.getByRole("button", { name: /Accept/ }).click();
  await expect(page.locator("#orders")).toContainText("PO-");
  list = (await (await request.get("/api/buyer-requirements", { headers: bh })).json()).requirements.find(r => r.id === id);
  expect(list.messages[0].subject).toMatch(/^Order PO-.* received/);
  expect(list.stateStep).toBe(4);

  // admin sees thread
  const th = await (await request.get(`/api/admin/requirements/${id}/messages`, { headers: ah })).json();
  expect(th.messages.length).toBeGreaterThanOrEqual(3);
});
