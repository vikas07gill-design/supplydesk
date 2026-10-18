const { test, expect } = require("@playwright/test");
// Only the SupplyDesk team lists products. A supplier can see them and update capacity, nothing else.
const KEY = process.env.E2E_TEST_KEY;
test.skip(!KEY, "needs E2E key");
const stamp = Date.now();

test("supplier cannot create, edit, delete or add photos to products", async ({ request }) => {
  const email = `lock-${stamp}@example.com`;
  const ask = await (await request.post("/api/supplier-signup/request-otp", { headers: { "x-e2e-key": KEY }, data: { company: "Lock Supplier " + stamp, contact: "Owner", email, phone: "+91 98100 00000", country: "India" } })).json();
  const v = await (await request.post("/api/supplier-signup/verify-otp", { data: { email, otp: ask.testOtp } })).json();
  const sh = { "x-supplier-dashboard-token": v.token };
  const id = "00000000-0000-4000-8000-000000000000";
  const attempts = [
    request.post("/api/supplier-dashboard/products", { headers: sh, data: { product_name: "X" } }),
    request.patch(`/api/supplier-dashboard/products/${id}`, { headers: sh, data: { product_name: "X" } }),
    request.delete(`/api/supplier-dashboard/products/${id}`, { headers: sh }),
    request.post(`/api/supplier-dashboard/products/${id}/images`, { headers: sh, multipart: { productImages: { name: "a.png", mimeType: "image/png", buffer: Buffer.from("x") } } }),
    request.delete(`/api/supplier-dashboard/products/${id}/images/${id}`, { headers: sh }),
  ];
  for (const r of await Promise.all(attempts)) {
    const res = r;
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("listing_locked");
  }
  // no token -> still unauthenticated, not a leak of the lock message
  expect((await request.post("/api/supplier-dashboard/products", { data: {} })).status()).toBe(401);
  // reading the (empty) list still works, and capacity edits are not blocked by the lock
  expect((await request.get("/api/supplier-dashboard/products", { headers: sh })).status()).toBe(200);
  const cap = await request.patch(`/api/supplier-dashboard/products/${id}/capacity`, { headers: sh, data: { monthly_capacity: 10 } });
  
  expect((await cap.json().catch(() => ({}))).code).not.toBe("listing_locked");
});

test("supplier dashboard page has no product listing form", async ({ request }) => {
  const html = await (await request.get("/supplier-dashboard.html")).text();
  for (const bad of ['id="productForm"', 'id="productModal"', "openProduct(", "archiveProduct(", "productSubcategory"]) expect(html).not.toContain(bad);
  expect(html).toContain("SupplyDesk lists and maintains your products");
});
