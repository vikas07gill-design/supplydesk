const { test, expect } = require("@playwright/test");
// Supplier identity, contact and exact capacity are visible to Super Admin only.
const AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!AID || !APW, "needs E2E_ADMIN_ID/E2E_ADMIN_PASSWORD");
const login = async (request, id, pw) => (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json());

test("normal admin sees alias + capacity band; super admin sees full supplier details", async ({ request }) => {
  test.skip(!SID || !SPW, "needs E2E_SUPER_ID/E2E_SUPER_PASSWORD");
  const KEY = process.env.E2E_TEST_KEY;
  const { products } = await (await request.get("/api/products")).json();
  const p = products.find(x => x.name === "E2E Test Product");
  const email = `sa-${Date.now()}@example.com`;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  await request.post("/api/connect-requests", { headers: { "x-e2e-key": KEY }, data: { productId: p.id, customerName: "SA Buyer", customerEmail: email, quantity: "10 pcs", dashboardToken: v.dashboardToken } });

  const a = { "x-admin-token": (await login(request, AID, APW)).token };
  const s = { "x-admin-token": (await login(request, SID, SPW)).token };
  const adminRows = (await (await request.get("/api/admin/connect-requests", { headers: a })).json()).requests;
  const superRows = (await (await request.get("/api/admin/connect-requests", { headers: s })).json()).requests;
  const ar = adminRows.find(r => r.customer_email === email), sr = superRows.find(r => r.customer_email === email);
  expect(JSON.stringify(ar)).not.toMatch(/India Growth|supplier-e2e@example\.com|80000|120000/);
  expect(ar.capacity_band).toBe("50,000 - 100,000");
  expect(sr.trade_name).toBe("India Growth");
  expect(Number(sr.available_capacity)).toBe(80000);

  const prods = (await (await request.get("/api/admin/products", { headers: a })).json()).products;
  expect(JSON.stringify(prods)).not.toMatch(/India Growth|supplier-e2e@example\.com/);
  const prodsS = (await (await request.get("/api/admin/products", { headers: s })).json()).products;
  expect(JSON.stringify(prodsS)).toMatch(/India Growth/);
});
