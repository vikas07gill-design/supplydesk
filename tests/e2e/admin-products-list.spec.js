const { test, expect } = require("@playwright/test");
// Regression: the Products screen opened on "Pending" only, so approved (live) products looked missing.
const AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD, SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!AID || !APW || !SID || !SPW, "needs admin + super admin env");

for (const [label, id, pw] of [["admin", AID, APW], ["super admin", SID, SPW]]) {
  test(`${label}: Products screen lists approved products by default`, async ({ request, page }) => {
    const login = await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json();
    await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [login.token, login.role]);
    await page.goto("/admin.html");
    await page.locator('button[data-tab="products"]').click();
    await expect(page.locator("#productStatus")).toHaveValue("all");
    await expect(page.locator("#list .row", { hasText: "E2E Test Product" })).toBeVisible();
    await page.selectOption("#productStatus", "pending");
    await expect(page.locator("#list .row", { hasText: "E2E Test Product" })).toHaveCount(0);
  });
}
