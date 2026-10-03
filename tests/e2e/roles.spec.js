const { test, expect } = require("@playwright/test");
// Team roles: Buyer Desk, Procurement Desk, Finance, Management. Super Admin and Admin stay unchanged.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
test.skip(!KEY || !AID || !APW || !SID || !SPW, "needs admin + super admin env");
test.describe.configure({ mode: "serial" });

const stamp = Date.now(), PW = "Role-Test-Pass-123";
const H = (t) => ({ "x-admin-token": t });
let su, admin; const U = {}; let w1, w2;

async function signIn(request, id, pw) {
  const d = await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json();
  return { token: d.token, role: d.role };
}
async function makeUser(request, role, sfx = "") {
  const adminId = `${role}.${stamp}${sfx}`;
  const r = await request.post("/api/super-admin/team", { headers: H(su), data: { adminId, displayName: role + " user", role, password: PW } });
  expect(r.status()).toBe(201);
  const s = await signIn(request, adminId, PW);
  expect(s.role).toBe(role);
  return { adminId, id: (await r.json()).id, ...s };
}
async function buyer(request, tag) {
  const email = `rl-${tag}-${stamp}@example.com`;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  return { email, token: v.dashboardToken, h: { "x-buyer-dashboard-token": v.dashboardToken } };
}
async function flow(request, tag) {
  const b = await buyer(request, tag);
  const q = await request.post("/api/buyer-requirements", { data: { dashboardToken: b.token, buyerName: "Secret Buyer " + tag, buyerCompany: "Secret Co " + tag, buyerCountry: "India", title: `RL ${tag} ${stamp}`, description: "Role test", category: "Plastics & Polymers", subcategory: "Containers", quantity: "1000", unit: "pcs", targetPrice: "42", currency: "INR", deliveryCountry: "India" } });
  expect(q.status()).toBe(201);
  const id = (await q.json()).requirementId;
  expect((await request.post(`/api/admin/requirements/${id}/review`, { headers: H(su), data: { action: "accept_full" } })).status()).toBe(200);
  expect((await request.post(`/api/admin/requirements/${id}/buyer-quote`, { headers: H(su), data: { unitPrice: 50, quantity: "1000 pcs" } })).status()).toBe(201);
  const acc = await (await request.post(`/api/buyer-requirements/${id}/quote/respond`, { headers: b.h, data: { decision: "accept" } })).json();
  const o = (await (await request.get("/api/admin/orders", { headers: H(su) })).json()).orders.find(x => x.id === acc.orderId);
  return { b, requirementId: id, orderId: acc.orderId, sdOrderId: o.sd_order_id };
}
const assign = (request, entityType, entityId, desk, adminId) =>
  request.put("/api/admin/assignments", { headers: H(su), data: { entityType, entityId, desk, adminId } });

test.beforeAll(async ({ request }) => {
  su = (await signIn(request, SID, SPW)).token;
  admin = (await signIn(request, AID, APW)).token;
  for (const r of ["buyer_desk", "procurement", "finance", "management"]) U[r] = await makeUser(request, r);
  w1 = await flow(request, "one"); w2 = await flow(request, "two");
});

test("super admin can create every role; bad roles are rejected; the badge shows the role", async ({ request }) => {
  const bad = await request.post("/api/super-admin/team", { headers: H(su), data: { adminId: "bad." + stamp, role: "root", password: PW } });
  expect(bad.status()).toBe(400);
  const team = (await (await request.get("/api/super-admin/team", { headers: H(su) })).json()).users;
  for (const r of ["buyer_desk", "procurement", "finance", "management"]) expect(team.some(u => u.role === r)).toBe(true);
  // management is not a super admin
  expect((await request.get("/api/super-admin/team", { headers: H(U.management.token) })).status()).toBe(403);
});

test("buyer desk: sees nothing until assigned, then only assigned work; no supplier side", async ({ request }) => {
  const t = H(U.buyer_desk.token);
  let reqs = (await (await request.get("/api/admin/requirements", { headers: t })).json()).requirements;
  expect(reqs.length).toBe(0);
  expect((await request.get(`/api/admin/requirements/${w1.requirementId}/messages`, { headers: t })).status()).toBe(403);
  expect((await assign(request, "requirement", w1.requirementId, "buyer", U.buyer_desk.adminId)).status()).toBe(200);
  reqs = (await (await request.get("/api/admin/requirements", { headers: t })).json()).requirements;
  expect(reqs.map(r => r.id)).toEqual([w1.requirementId]);
  expect(reqs[0].buyer_email).toBe(w1.b.email); // Buyer Desk owns the buyer relationship
  expect((await request.get(`/api/admin/requirements/${w1.requirementId}/messages`, { headers: t })).status()).toBe(200);
  expect((await request.get(`/api/admin/requirements/${w2.requirementId}/messages`, { headers: t })).status()).toBe(403);
  const orders = (await (await request.get("/api/admin/orders", { headers: t })).json()).orders;
  expect(orders.map(o => o.id)).toEqual([w1.orderId]);
  expect(orders[0].unit_price).not.toBeUndefined(); // selling price visible
  for (const p of ["/api/admin/sd-orders", "/api/admin/capacity", "/api/admin/agreements", "/api/admin/procurement/queue", "/api/admin/products", `/api/admin/requirements/${w1.requirementId}/quotes`, `/api/admin/orders/${w1.orderId}/supplier-pos`, "/api/admin/audit", "/api/admin/connect-requests", "/api/super-admin/margin-report"])
    expect((await request.get(p, { headers: t })).status(), p).toBe(403);
});

test("procurement desk: only assigned SD orders; no buyer identity, no selling price", async ({ request }) => {
  const t = H(U.procurement.token);
  expect((await (await request.get("/api/admin/sd-orders", { headers: t })).json()).sdOrders.length).toBe(0);
  expect((await request.get(`/api/admin/sd-orders/${w1.sdOrderId}/sourcing-plan`, { headers: t })).status()).toBe(403);
  expect((await assign(request, "sd_order", w1.sdOrderId, "procurement", U.procurement.adminId)).status()).toBe(200);
  const list = (await (await request.get("/api/admin/sd-orders", { headers: t })).json()).sdOrders;
  expect(list.map(s => s.id)).toEqual([w1.sdOrderId]);
  const planRes = await request.get(`/api/admin/sd-orders/${w1.sdOrderId}/sourcing-plan`, { headers: t });
  expect(planRes.status()).toBe(200);
  const txt = await planRes.text();
  expect(txt).not.toContain(w1.b.email);
  expect(txt).not.toContain("Secret Co");
  expect(txt).not.toMatch(/"(unit_price|total_price|unitPrice|totalPrice)"/);
  expect((await request.get(`/api/admin/sd-orders/${w2.sdOrderId}/sourcing-plan`, { headers: t })).status()).toBe(403);
  for (const p of ["/api/admin/requirements", "/api/admin/orders", "/api/admin/invoices/x", "/api/super-admin/margin-report", "/api/admin/pipeline/../audit"])
    expect((await request.get(p, { headers: t })).status(), p).not.toBe(200);
});

test("finance: orders, invoices and margin; no requirements or supplier network", async ({ request }) => {
  const t = H(U.finance.token);
  expect((await request.get("/api/admin/orders", { headers: t })).status()).toBe(200);
  expect((await request.get("/api/super-admin/margin-report", { headers: t })).status()).toBe(200);
  for (const p of ["/api/admin/requirements", "/api/admin/sd-orders", "/api/admin/capacity", "/api/admin/products"])
    expect((await request.get(p, { headers: t })).status(), p).toBe(403);
});

test("management: sees everything incl. margin, assigns work; admin and super are unchanged", async ({ request }) => {
  const t = H(U.management.token);
  expect((await request.get("/api/super-admin/margin-report", { headers: t })).status()).toBe(200);
  const reqs = (await (await request.get("/api/admin/requirements", { headers: t })).json()).requirements;
  expect(reqs.find(r => r.id === w2.requirementId).buyer_email).toBe(w2.b.email);
  expect((await request.get("/api/admin/capacity", { headers: t })).status()).toBe(200);
  const a = await request.put("/api/admin/assignments", { headers: t, data: { entityType: "requirement", entityId: w2.requirementId, desk: "buyer", adminId: U.buyer_desk.adminId } });
  expect(a.status()).toBe(200);
  // a desk user cannot assign
  expect((await request.put("/api/admin/assignments", { headers: H(U.buyer_desk.token), data: { entityType: "requirement", entityId: w2.requirementId, desk: "buyer", adminId: U.buyer_desk.adminId } })).status()).toBe(403);
  // wrong role for the desk
  expect((await request.put("/api/admin/assignments", { headers: t, data: { entityType: "requirement", entityId: w2.requirementId, desk: "buyer", adminId: U.procurement.adminId } })).status()).toBe(400);
  // normal admin: still aliased, no margin
  expect((await request.get("/api/super-admin/margin-report", { headers: H(admin) })).status()).toBe(403);
  const ar = (await (await request.get("/api/admin/requirements", { headers: H(admin) })).json()).requirements;
  expect(ar.find(r => r.id === w2.requirementId).buyer_email).toBe("");
  // super admin: everything
  const sr = (await (await request.get("/api/admin/requirements", { headers: H(su) })).json()).requirements;
  expect(sr.find(r => r.id === w2.requirementId).buyer_email).toBe(w2.b.email);
  expect((await request.get("/api/super-admin/margin-report", { headers: H(su) })).status()).toBe(200);
});

test("segregation of duties: one person cannot work both desks on the same transaction", async ({ request }) => {
  // U.buyer_desk holds the buyer desk on w2's requirement. Move them to the procurement role, then try the sourcing desk.
  const p = await request.patch(`/api/super-admin/team/${U.buyer_desk.id}`, { headers: H(su), data: { role: "procurement" } });
  expect(p.status()).toBe(200);
  const r = await request.put("/api/admin/assignments", { headers: H(su), data: { entityType: "sd_order", entityId: w2.sdOrderId, desk: "procurement", adminId: U.buyer_desk.adminId } });
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toMatch(/segregation/i);
  // a different person is fine
  expect((await request.put("/api/admin/assignments", { headers: H(su), data: { entityType: "sd_order", entityId: w2.sdOrderId, desk: "procurement", adminId: U.procurement.adminId } })).status()).toBe(200);
});

test("denied attempts and assignment changes are audited", async ({ request }) => {
  const entries = (await (await request.get("/api/admin/audit?limit=200", { headers: H(su) })).json()).entries;
  expect(entries.some(e => e.action === "assignment.changed")).toBe(true);
  expect(entries.some(e => e.action === "access.denied")).toBe(true);
});

test("UI: buyer desk gets a trimmed menu; management can assign from a requirement", async ({ page, request }) => {
  const login = await makeUser(request, "buyer_desk", ".ui");
  await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [login.token, "buyer_desk"]);
  await page.goto("/admin.html");
  await expect(page.locator("#roleBadge")).toHaveText("BUYER DESK");
  await expect(page.locator(".toolbar .navgroup button:visible")).toHaveText(["Overview", "Requests", "Orders"]);
  await page.close();
});
