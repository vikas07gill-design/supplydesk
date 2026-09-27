import { test, expect } from "@playwright/test";

const publicPages = [
  "/",
  "/index.html",
  "/search.html",
  "/categories.html",
  "/services.html",
  "/supplier.html?id=india-growth",
  "/product.html",
  "/supplier-register.html",
  "/buyer-dashboard.html",
  "/supplier-dashboard.html"
];

test.describe("SupplyDesk production smoke tests", () => {
  test("public pages return successfully", async ({ request }) => {
    for (const path of publicPages) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
    }
  });

  test("API health endpoint is alive", async ({ request }) => {
    const response = await request.get("/api/version");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.build).toBeTruthy();
  });

  test("public products API is healthy", async ({ request }) => {
    const response = await request.get("/api/products");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.products)).toBe(true);
  });

  test("legacy supplier slug resolves to a public supplier", async ({ request }) => {
    const response = await request.get("/api/suppliers/india-growth");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.supplier).toBeTruthy();
    expect(body.supplier.id).toBeTruthy();
  });

  test("supplier products API resolves the same legacy slug", async ({ request }) => {
    const response = await request.get("/api/suppliers/india-growth/products");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.products)).toBe(true);
  });

  test("homepage renders without a browser crash", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/SupplyDesk/i);
    expect(errors, "Uncaught browser errors").toEqual([]);
  });

  test("supplier profile page renders without a browser crash", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/supplier.html?id=india-growth", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText(/Supplier/i);
    expect(errors, "Uncaught browser errors").toEqual([]);
  });

  test("product page renders and keeps enquiry UI available", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/product.html", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText(/Connect|Enquiry|Product/i);
    expect(errors, "Uncaught browser errors").toEqual([]);
  });
});
