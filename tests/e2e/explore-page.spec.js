import { test, expect } from "@playwright/test";

test.describe("Industries & Countries explorer", () => {
  test("typing a country or a natural query applies filters and lists seeded supplier", async ({ page }) => {
    await page.goto("/explore.html");
    await expect(page.locator(".card").first()).toBeVisible();
    await page.fill("#q", "plastic packaging in bharat");
    await expect(page.locator("#chips")).toContainText("Plastics & Packaging");
    await expect(page.locator("#chips")).toContainText("India");
    await expect(page.locator("a.card[href*=\"supplier.html\"]", { hasText: "India Growth" })).toBeVisible();
    await page.fill("#q", "uae");
    await expect(page.locator("#suggest")).toContainText("United Arab Emirates");
  });
  test("legacy categories page redirects to the explorer", async ({ page }) => {
    await page.goto("/categories.html");
    await expect(page).toHaveURL(/explore\.html/);
  });
});
