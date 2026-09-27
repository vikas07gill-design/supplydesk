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
  "/buyer-dashboard.html",
  "/supplier-dashboard.html"
];

async function getPublishedSupplierId(request) {
  const response = await request.get("/api/products");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(Array.isArray(body.products)).toBe(true);
  expect(body.products.length, "At least one public product must exist").toBeGreaterThan(0);

  const supplier = body.products[0]?.supplier;
  const supplierId = supplier?.id || body.products[0]?.supplierId;
  expect(supplierId, "Public product must expose its supplier id").toBeTruthy();
  return supplierId;
}

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

  test("public supplier APIs resolve a currently published supplier", async ({ request }) => {
    const supplierId = await getPublishedSupplierId(request);

    const supplierResponse = await request.get("/api/suppliers/" + encodeURIComponent(supplierId));
    expect(supplierResponse.status()).toBe(200);
    const supplierBody = await supplierResponse.json();
    expect(supplierBody.supplier?.id).toBe(supplierId);

    const productsResponse = await request.get("/api/suppliers/" + encodeURIComponent(supplierId) + "/products");
    expect(productsResponse.status()).toBe(200);
    const productsBody = await productsResponse.json();
    expect(Array.isArray(productsBody.products)).toBe(true);
  });

  test("homepage renders without a browser crash", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/SupplyDesk/i);
    expect(errors, "Uncaught browser errors").toEqual([]);
  });

  test("supplier profile page renders without a browser crash", async ({ page, request }) => {
    const supplierId = await getPublishedSupplierId(request);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/supplier.html?id=" + encodeURIComponent(supplierId), { waitUntil: "domcontentloaded" });
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
