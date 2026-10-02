import { test, expect } from "@playwright/test";

const publicPages = [
  "/",
  "/index.html",
  "/search.html",
  "/categories.html",
  "/services.html",
  "/supplier.html",
  "/product.html",
  "/supplier-register.html",
  "/requirement.html",
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

  test("public supplier identity stays private", async ({ request }) => {
    const list = await (await request.get("/api/suppliers")).json();
    expect(list.suppliers).toEqual([]);
    expect((await request.get("/api/suppliers/any-supplier")).status()).toBe(404);
    const body = await (await request.get("/api/products")).json();
    for (const product of body.products) {
      expect(product.supplierId, "product must not expose supplier id").toBeUndefined();
      expect(product.supplierName, "product must not expose supplier name").toBeUndefined();
      expect(product.capacity, "product exposes capacity block").toBeTruthy();
    }
  });

  test("homepage renders without a browser crash", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/SupplyDesk/i);
    expect(errors, "Uncaught browser errors").toEqual([]);
  });

  test("supplier profile page shows the private notice", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/supplier.html?id=anything", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText(/Supplier profiles are private/i);
    expect(errors, "Uncaught browser errors").toEqual([]);
  });

  test("product page renders and keeps enquiry UI available", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/product.html", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText(/Request Quote|Product/i);
    expect(errors, "Uncaught browser errors").toEqual([]);
  });
});


test("requirement page renders without a browser crash", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/requirement.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toContainText(/Tell us what you need/i);
  expect(errors, "Uncaught browser errors").toEqual([]);
});
