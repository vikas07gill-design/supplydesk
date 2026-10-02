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
