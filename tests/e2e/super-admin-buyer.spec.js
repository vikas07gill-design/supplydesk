const { test, expect } = require("@playwright/test");
// Buyer identity (name, company, email, phone) is visible to Super Admin only.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!KEY || !AID || !APW || !SID || !SPW, "needs admin + super env");
const login = async (request, id, pw) => ({ "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json()).token });

test("normal admin never sees buyer contact details; super admin does", async ({ request }) => {
  const stamp = Date.now(), email = `secret-${stamp}@buyerco.test`, name = "Secretname" + stamp, company = "Secretco" + stamp;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  const bh = { "x-buyer-dashboard-token": v.dashboardToken };
  await request.patch("/api/buyer-dashboard/profile", { headers: bh, data: { name, company, country: "India", phone: "+91 99999 11111" } }).catch(() => {});
  const { requirementId: id } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: name, buyerCompany: company, buyerCountry: "India", buyerPhone: "+91 99999 11111", title: "Mask " + stamp, description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "100 pcs", deliveryCountry: "India" } })).json();
  const a = await login(request, AID, APW), s = await login(request, SID, SPW);
  await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: a, data: { unitPrice: 10, quantity: "100 pcs" } });
  await request.post(`/api/buyer-requirements/${id}/quote/respond`, { headers: bh, data: { decision: "accept" } });

  const leak = /secret-\d+@buyerco|Secretname|Secretco|99999 ?11111/;
  for (const url of ["/api/admin/requirements", "/api/admin/procurement/queue", "/api/admin/orders", "/api/admin/connect-requests", `/api/admin/audit?entity=rfq&id=${id}`, "/api/admin/audit"]) {
    const r = await request.get(url, { headers: a });
    expect(r.status(), url).toBe(200);
    expect(await r.text(), url).not.toMatch(leak);
  }
  const alias = (await (await request.get("/api/admin/requirements", { headers: a })).json()).requirements.find(r => r.id === id);
  expect(alias.buyer_name).toMatch(/^Buyer [0-9A-F]{6}$/);
  const sup = await (await request.get("/api/admin/requirements", { headers: s })).json();
  const sr = sup.requirements.find(r => r.id === id);
  expect(sr.buyer_email).toBe(email);
  expect(sr.buyer_name).toBe(name);
});
