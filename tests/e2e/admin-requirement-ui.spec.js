const { test, expect } = require("@playwright/test");
// Initial review shows ONLY: summary, Accept full / Accept partial / Reject, notes and the activity timeline.
// No supplier selection at this stage. Later states show one clear next step.
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

  // lands on the Overview pipeline; Requests opens the queue
  await expect(page.locator(".pl-stage")).toHaveCount(9);
  await page.locator("#requirementsBtn").click();
  await expect(page.locator(".rq-tab.on")).toContainText("Needs action");
  await page.locator(".rq-search").fill(title);
  await page.locator(".rq-row", { hasText: title }).click();
  const d = page.locator("#detail");
  await expect(d.locator(".rq-next-h")).toContainText("Decision");
  await expect(d.locator(".dec-row button")).toHaveCount(3);
  await expect(d.getByRole("button", { name: "Accept in full" })).toBeVisible();
  await expect(d.getByRole("button", { name: "Accept partially" })).toBeVisible();
  await expect(d.getByRole("button", { name: "Reject" })).toBeVisible();
  await expect(d.locator("#reqAdminNotes")).toHaveCount(1);
  await expect(d.locator(".tl-i").first()).toContainText("Requirement received");
  // nothing about suppliers at the initial review, and none of the later-stage sections
  await expect(d.locator(".reqSup")).toHaveCount(0);
  await expect(d).not.toContainText(/Choose suppliers|Send to selected suppliers|Capability matches|Supplier quotations/);
  await expect(d.locator("details.rq-sec")).toHaveCount(0);
  await expect(d.locator("#bqPrice")).toHaveCount(0);          // quote form not shown yet
  await expect(d).not.toContainText(email);                      // normal admin: no buyer contact

  // partial acceptance asks for a quantity only when chosen
  await expect(d.locator("#reqAccQty")).toBeHidden();
  await d.getByRole("button", { name: "Accept partially" }).click();
  await expect(d.locator("#reqAccQty")).toBeVisible();

  // accept in full -> costing -> quote form is the next step
  page.on("dialog", x => x.accept());
  await d.getByRole("button", { name: "Accept in full" }).click();
  await expect(d.locator(".rq-next.done .rq-next-h")).toContainText("Accepted in full");
  await expect(d.locator(".rq-next:not(.done) .rq-next-h")).toContainText("Send the quotation");
  await d.locator("#bqPrice").fill("30");
  await d.getByRole("button", { name: /Send quotation/ }).click();
  await expect(d.locator(".rq-next:not(.done) .rq-next-h")).toContainText("waiting for the buyer");

  // message from the collapsed section
  await d.locator("summary", { hasText: "Messages with buyer" }).click();
  await d.locator("#bmText").fill("Hello from admin " + title);
  await d.getByRole("button", { name: "Send message" }).click();
  await expect(d.locator(".rq-msg", { hasText: "Hello from admin" })).toBeVisible();
  const mine = (await (await request.get("/api/buyer-requirements", { headers: { "x-buyer-dashboard-token": v.dashboardToken } })).json()).requirements.find(r => r.id === id);
  expect(mine.messages.some(m => m.body && m.body.includes("Hello from admin"))).toBeTruthy();
});
