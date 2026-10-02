const { test, expect } = require("@playwright/test");
const KEY = process.env.E2E_TEST_KEY;

test("public nav sends Login / Sign Up to the buyer flow, not the supplier one", async ({ page }) => {
  await page.goto("/index.html");
  const login = page.locator(".actions a", { hasText: "Login" }).first();
  const signup = page.locator(".actions a", { hasText: "Sign Up" }).first();
  await expect(login).toHaveAttribute("href", "buyer-login.html");
  await expect(signup).toHaveAttribute("href", /buyer-login\.html\?mode=signup/);
  await expect(page.locator(".actions a[href*='supplier']")).toHaveCount(0);
  for (const p of ["/search.html", "/explore.html"]) {
    await page.goto(p);
    await expect(page.locator("nav a[href='buyer-login.html']")).toHaveCount(1);
    await expect(page.locator("nav a[href*='supplier-register']")).toHaveCount(0);
  }
});

test("buyer-login page renders and signup mode changes the heading", async ({ page }) => {
  await page.goto("/buyer-login.html?mode=signup");
  await expect(page.locator("#title")).toContainText("Get started");
  await expect(page.locator("#email")).toBeVisible();
  await page.goto("/buyer-dashboard.html");   // no token -> sent to the buyer login, not the home page
  await expect(page).toHaveURL(/buyer-login\.html/);
});

test("email OTP login creates the session and opens the buyer dashboard", async ({ page }) => {
  test.skip(!KEY, "needs E2E_TEST_KEY");
  await page.route("**/api/buyer-email/request-otp", route => route.continue({ headers: { ...route.request().headers(), "x-e2e-key": KEY } }));
  await page.goto("/buyer-login.html");
  await page.fill("#email", `login-${Date.now()}@example.com`);
  await page.click("#go");
  await expect(page.locator("#otp")).toHaveValue(/^\d{6}$/);
  await page.click("#go");
  await expect(page).toHaveURL(/buyer-dashboard/);
  await expect(page.locator("h1")).toContainText("Your sourcing activity");
});

test.describe("login persists while browsing", () => {
  test.skip(!KEY, "needs E2E_TEST_KEY");
  async function login(page, request) {
    const email = `stay-${Date.now()}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    await page.addInitScript(t => localStorage.setItem("supplydesk_buyer_dashboard_token", t), v.dashboardToken);
    return { email, token: v.dashboardToken };
  }

  test("public pages show My Dashboard / Logout instead of Login / Sign Up, and Logout ends the session", async ({ page, request }) => {
    await login(page, request);
    for (const p of ["/index.html", "/search.html", "/explore.html"]) {
      await page.goto(p);
      await expect(page.locator("a", { hasText: "My Dashboard" }).first()).toHaveAttribute("href", "buyer-dashboard.html");
      await expect(page.locator("a[href^='buyer-login.html']")).toHaveCount(0);
    }
    await page.goto("/index.html");
    await page.locator("a", { hasText: "Logout" }).first().click();
    await expect(page).toHaveURL(/index\.html/);
    await expect(page.locator(".actions a", { hasText: "Login" }).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("supplydesk_buyer_dashboard_token"))).toBeNull();
  });

  test("an expired session falls back to Login", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("supplydesk_buyer_dashboard_token", "bad-token"));
    await page.goto("/index.html");
    await expect(page.locator(".actions a", { hasText: "Login" }).first()).toBeVisible();
  });

  test("requirement page does not ask a logged-in buyer to verify the email again", async ({ page, request }) => {
    const { email } = await login(page, request);
    await page.goto("/requirement.html");
    await expect(page.locator("#email")).toHaveValue(email);
    await expect(page.locator("#verifyStatus")).toContainText("already verified");
    await expect(page.locator("#sendOtp")).toBeHidden();
  });
});
