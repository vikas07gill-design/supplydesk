const { test, expect } = require("@playwright/test");
// App-store requirement: users can delete their own account. Personal data goes, commercial records stay (anonymised).
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
test.skip(!KEY || !AID || !APW, "needs admin env");
test.describe.configure({ mode: "serial" });
const stamp = Date.now();

async function buyer(request, tag) {
  const email = `del-${tag}-${stamp}-${Math.floor(Math.random() * 1e5)}@example.com`;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  return { email, token: v.dashboardToken, h: { "x-buyer-dashboard-token": v.dashboardToken } };
}
const adminH = async (request) => ({ "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json()).token });
const newReq = (request, b, tag) => request.post("/api/buyer-requirements", { data: { dashboardToken: b.token, buyerName: "Del Buyer", buyerCompany: "Del Co", buyerCountry: "India", title: `DEL ${tag} ${stamp}`, description: "Need containers", specifications: "x", category: "Plastics & Polymers", subcategory: "Containers", quantity: 500, unit: "pcs", deliveryCountry: "India" } });

test("buyer: confirmation word is required, then deletion revokes access and frees the email", async ({ request }) => {
  const b = await buyer(request, "plain");
  expect((await request.post("/api/buyer-dashboard/delete-account", { headers: b.h, data: {} })).status()).toBe(400);
  expect((await request.post("/api/buyer-dashboard/delete-account", { headers: b.h, data: { confirm: "delete me" } })).status()).toBe(400);
  expect((await request.get("/api/buyer-dashboard", { headers: b.h })).status()).toBe(200);
  const r = await newReq(request, b, "plain");
  expect([200, 201]).toContain(r.status());
  const del = await request.post("/api/buyer-dashboard/delete-account", { headers: b.h, data: { confirm: "DELETE" } });
  expect(del.status()).toBe(200);
  expect((await request.get("/api/buyer-dashboard", { headers: b.h })).status()).toBe(401);
  // the same email can register again as a brand-new buyer with no old data
  const o = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email: b.email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email: b.email, otp: o.testOtp } })).json();
  const dash = await (await request.get("/api/buyer-dashboard", { headers: { "x-buyer-dashboard-token": v.dashboardToken } })).json();
  expect(dash.enquiries).toHaveLength(0);
  expect(dash.buyer.company).toBe("");
});

test("buyer with an open order cannot delete yet", async ({ request }) => {
  const ah = await adminH(request), b = await buyer(request, "open");
  const id = (await (await newReq(request, b, "open")).json()).requirementId;
  expect((await request.post(`/api/admin/requirements/${id}/review`, { headers: ah, data: { action: "accept_full" } })).status()).toBe(200);
  expect((await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: ah, data: { unitPrice: 50, quantity: "500 pcs" } })).status()).toBe(201);
  expect((await request.post(`/api/buyer-requirements/${id}/quote/respond`, { headers: b.h, data: { decision: "accept" } })).status()).toBe(201);
  const del = await request.post("/api/buyer-dashboard/delete-account", { headers: b.h, data: { confirm: "DELETE" } });
  expect(del.status()).toBe(409);
  expect((await del.json()).code).toBe("open_orders");
  expect((await request.get("/api/buyer-dashboard", { headers: b.h })).status()).toBe(200); // still logged in, nothing changed
});

test("supplier: deletion erases the login and the email can be reused", async ({ request }) => {
  const email = `del-sup-${stamp}@example.com`;
  const signup = async () => {
    const ask = await (await request.post("/api/supplier-signup/request-otp", { headers: { "x-e2e-key": KEY }, data: { company: "Del Supplier " + stamp, contact: "Owner", email, phone: "+91 98100 00000", country: "India" } })).json();
    const v = await (await request.post("/api/supplier-signup/verify-otp", { data: { email, otp: ask.testOtp } })).json();
    return { "x-supplier-dashboard-token": v.token };
  };
  const sh = await signup();
  expect((await request.post("/api/supplier-dashboard/delete-account", { headers: sh, data: {} })).status()).toBe(400);
  expect((await request.post("/api/supplier-dashboard/delete-account", { headers: sh, data: { confirm: "DELETE" } })).status()).toBe(200);
  expect((await request.get("/api/supplier-dashboard/products", { headers: sh })).status()).toBe(401);
  // old email is no longer a supplier login...
  expect((await request.post("/api/supplier-dashboard/request-otp", { data: { email } })).status()).toBe(404);
  // ...and can be registered afresh
  const sh2 = await signup();
  expect((await request.get("/api/supplier-dashboard/products", { headers: sh2 })).status()).toBe(200);
});
