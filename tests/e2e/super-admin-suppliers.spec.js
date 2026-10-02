const { test, expect } = require("@playwright/test");
// Supplier directory is Super Admin only; public and normal Admin never see it.
const AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!AID || !APW, "needs admin env");
const login = async (request, id, pw) => (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json());

test("supplier directory: public + admin blocked, super admin sees full list", async ({ request }) => {
  test.skip(!SID || !SPW, "needs super env");
  expect((await request.get("/api/super-admin/suppliers")).status()).toBeGreaterThanOrEqual(401);
  expect((await (await request.get("/api/suppliers")).json()).suppliers).toEqual([]);
  const a = { "x-admin-token": (await login(request, AID, APW)).token };
  expect((await request.get("/api/super-admin/suppliers", { headers: a })).status()).toBeGreaterThanOrEqual(401);
  const s = { "x-admin-token": (await login(request, SID, SPW)).token };
  const r = await request.get("/api/super-admin/suppliers", { headers: s });
  expect(r.status()).toBe(200);
  const { suppliers } = await r.json();
  expect(suppliers.length).toBeGreaterThan(0);
  expect(suppliers.some(x => x.trade_name === "India Growth" && x.business_email)).toBeTruthy();
  const q = await (await request.get("/api/super-admin/suppliers?q=zzzz-none", { headers: s })).json();
  expect(q.suppliers).toEqual([]);
});

test("super admin can change supplier email; admin cannot; invalid rejected", async ({ request }) => {
  test.skip(!SID || !SPW, "needs super env");
  const s = { "x-admin-token": (await login(request, SID, SPW)).token };
  const a = { "x-admin-token": (await login(request, AID, APW)).token };
  const { suppliers } = await (await request.get("/api/super-admin/suppliers", { headers: s })).json();
  const sup = suppliers.find(x => x.trade_name === "India Growth");
  const url = `/api/super-admin/suppliers/${sup.id}/email`;
  expect((await request.patch(url, { headers: a, data: { businessEmail: "x@example.com" } })).status()).toBeGreaterThanOrEqual(401);
  expect((await request.patch(url, { headers: s, data: { businessEmail: "not-an-email" } })).status()).toBe(400);
  expect((await request.patch(url, { headers: s, data: { businessEmail: sup.business_email } })).status()).toBe(200);
});
