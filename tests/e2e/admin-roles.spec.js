const { test, expect } = require("@playwright/test");
// Needs E2E_ADMIN_ID/PASSWORD (normal admin). Optional E2E_SUPER_ID/PASSWORD enables team tests.
const AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!AID || !APW, "needs E2E_ADMIN_ID and E2E_ADMIN_PASSWORD");
const login = async (request, id, pw) => (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json());

test("normal admin cannot use test tools or manage the team", async ({ request }) => {
  const a = await login(request, AID, APW);
  const h = { "x-admin-token": a.token };
  expect((await request.post("/api/admin/test-email", { headers: h, data: { recipient: "x@example.com" } })).status()).toBe(403);
  expect((await request.get("/api/admin/test-connection-storage", { headers: h })).status()).toBe(403);
  expect((await request.get("/api/super-admin/team", { headers: h })).status()).toBe(403);
});

test("super admin can create, disable and re-enable a team account", async ({ request }) => {
  test.skip(!SID || !SPW, "needs E2E_SUPER_ID/E2E_SUPER_PASSWORD");
  const s = await login(request, SID, SPW), h = { "x-admin-token": s.token };
  const id = "e2e." + Date.now(), pw = "Str0ng-Pass-" + Date.now();
  expect((await request.post("/api/super-admin/team", { headers: h, data: { adminId: id, role: "admin", password: pw } })).status()).toBe(201);
  expect((await request.post("/api/super-admin/team", { headers: h, data: { adminId: id, role: "admin", password: pw } })).status()).toBe(409);
  const u = (await (await request.get("/api/super-admin/team", { headers: h })).json()).users.find(x => x.admin_id === id);
  const t = await login(request, id, pw);
  expect(t.role).toBe("admin");
  await request.patch("/api/super-admin/team/" + u.id, { headers: h, data: { active: false } });
  expect((await request.get("/api/admin/requirements", { headers: { "x-admin-token": t.token } })).status()).toBe(401);
  expect((await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).status()).toBe(401);
});
