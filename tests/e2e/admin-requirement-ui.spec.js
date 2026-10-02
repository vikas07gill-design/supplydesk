const { test, expect } = require("@playwright/test");
// Admin requirement detail shows ONE clear next step per state, with the rest collapsed.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
test.skip(!KEY || !AID || !APW, "needs admin env");

test("requirement detail is state-aware", async ({ request, page }) => {
  const email = `ui-${Date.now()}@example.com`;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  const title = "UI Flow " + Date.now();
  const { requirementId: id } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "UI Buyer", buyerCountry: "India", title, description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "100 pcs", deliveryCountry: "India" } })).json();
  const login = await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json();
  await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [login.token, login.role]);
  await page.goto("/admin.html");

  // list: grouped tabs, search finds the row, click opens detail
  await expect(page.locator(".rq-tab.on")).toContainText("Needs action");
  await page.locator(".rq-search").fill(title);
  await page.locator(".rq-row", { hasText: title }).click();
  const d = page.locator("#detail");
  await expect(d.locator(".rq-next-h")).toContainText("Review this requirement");
  await expect(d.locator(".rq-opt")).toHaveCount(3);
  await expect(d.locator("#bqPrice")).toHaveCount(0);          // quote form not shown yet
  await expect(d.locator("details.rq-sec[open]")).toHaveCount(0); // everything else collapsed
  await expect(d).not.toContainText(email);                      // normal admin: no buyer contact

  // choose "SupplyDesk supplies directly" -> costing -> quote form is the next step
  page.on("dialog", x => x.accept());
  await d.getByRole("button", { name: "Handle directly" }).click();
  await expect(d.locator(".rq-next-h")).toContainText("Send the quotation");
  await d.locator("#bqPrice").fill("30");
  await d.getByRole("button", { name: /Send quotation/ }).click();
  await expect(d.locator(".rq-next-h")).toContainText("waiting for the buyer");

  // message from the collapsed section
  await d.locator("summary", { hasText: "Messages with buyer" }).click();
  await d.locator("#bmText").fill("Hello from admin " + title);
  await d.getByRole("button", { name: "Send message" }).click();
  await expect(d.locator(".rq-msg", { hasText: "Hello from admin" })).toBeVisible();
  const mine = (await (await request.get("/api/buyer-requirements", { headers: { "x-buyer-dashboard-token": v.dashboardToken } })).json()).requirements.find(r => r.id === id);
  expect(mine.messages.some(m => m.body && m.body.includes("Hello from admin"))).toBeTruthy();
});
