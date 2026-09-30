import { test, expect } from "@playwright/test";

const EMAIL = "buyer-e2e@example.com";

test.describe("SupplyDesk full buyer enquiry flow", () => {
  test("seeded supplier legacy slug resolves", async ({ request }) => {
    const response = await request.get("/api/suppliers/india-growth");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.supplier).toBeTruthy();
    expect(body.supplier.trade_name).toBe("India Growth");
  });

  test("OTP verification -> enquiry -> buyer dashboard", async ({ page }) => {
    const productsResponse = await page.request.get("/api/products");
    expect(productsResponse.status()).toBe(200);
    const productsBody = await productsResponse.json();
    const seededProduct = productsBody.products.find(product => product.name === "E2E Test Product");
    expect(seededProduct, "Seeded E2E product must be visible through the public products API").toBeTruthy();
    const productId = seededProduct.id;
    expect(productId).toBeTruthy();

    const detailResponse = await page.request.get("/api/products/" + encodeURIComponent(productId));
    expect(detailResponse.status(), "Seeded product detail API must resolve").toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.product?.name).toBe("E2E Test Product");

    await page.goto("/product.html?id=" + encodeURIComponent(productId), { waitUntil: "domcontentloaded" });
    await expect(page.locator("#name")).toHaveText("E2E Test Product");

    await page.locator("#connectBtn").click();
    await page.locator("#connectName").fill("E2E Buyer");
    await page.locator("#connectEmail").fill(EMAIL);
    await page.locator("#connectCompany").fill("E2E Test Company");
    await page.locator("#connectCountry").fill("India");
    await page.locator("#connectQuantity").fill("100 pcs");
    await page.locator("#connectMessage").fill("Automated end-to-end enquiry test.");

    const otpResponsePromise = page.waitForResponse(response =>
      response.url().includes("/api/buyer-email/request-otp") && response.request().method() === "POST"
    );
    await page.locator("#sendOtpBtn").click();
    const otpResponse = await otpResponsePromise;
    expect(otpResponse.ok()).toBe(true);
    const otpBody = await otpResponse.json();
    expect(otpBody.testOtp).toMatch(/^\d{6}$/);

    await page.locator("#connectOtp").fill(otpBody.testOtp);
    await page.locator("#verifyOtpBtn").click();

    await expect(page.locator("#emailVerified")).toHaveClass(/show/);
    await expect(page.locator("#connectSubmit")).toBeEnabled();

    const enquiryResponsePromise = page.waitForResponse(response =>
      response.url().includes("/api/connect-requests") && response.request().method() === "POST"
    );
    await page.locator("#connectSubmit").click();
    const enquiryResponse = await enquiryResponsePromise;
    expect(enquiryResponse.status()).toBe(201);

    const enquiryBody = await enquiryResponse.json();
    expect(enquiryBody.ok).toBe(true);
    expect(enquiryBody.enquiryId).toBeTruthy();

    await expect(page.locator("#connectStatus")).toContainText(/sent/i);

    const dashboardResponse = await page.request.get("/api/buyer-dashboard", {
      headers: { "x-buyer-dashboard-token": await page.evaluate(() => localStorage.getItem("supplydesk_buyer_dashboard_token")) }
    });
    expect(dashboardResponse.ok()).toBe(true);
    const dashboard = await dashboardResponse.json();
    expect(dashboard.buyer.email).toBe(EMAIL);
    expect(dashboard.enquiries.some(e => e.id === enquiryBody.enquiryId && e.productId === productId)).toBe(true);
  });
});
