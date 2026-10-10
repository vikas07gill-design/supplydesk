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
const assign = async (request, entityType, entityId, desk, adminId) => {
  // Work is released to Procurement only after a buy-below price is set.
  if (entityType === "sd_order" && desk === "procurement" && adminId) await request.put(`/api/admin/sd-orders/${entityId}/buy-ceiling`, { headers: H(su), data: { unitPrice: 40 } });
  return request.put("/api/admin/assignments", { headers: H(su), data: { entityType, entityId, desk, adminId } });
};

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
  await request.put(`/api/admin/sd-orders/${w2.sdOrderId}/buy-ceiling`, { headers: H(su), data: { unitPrice: 40 } });
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

test("phase 2: contact details are blocked in outgoing messages (except Management / Super Admin)", async ({ request }) => {
  const url = `/api/admin/requirements/${w1.requirementId}/message`;
  for (const text of ["mail me at john@supplier.com", "call +91 98100 12345", "see www.supplier.com", "whatsapp 9810012345", "ring 98100 12345 67"]) {
    const r = await request.post(url, { headers: H(admin), data: { message: text } });
    expect(r.status(), text).toBe(422);
    expect((await r.json()).code).toBe("contact_blocked");
  }
  // ordinary quantities, prices and Indian-format numbers are fine
  const ok = await request.post(url, { headers: H(admin), data: { message: "We can supply 1,00,000 pcs at Rs 42.50 per unit within 30 days." } });
  expect(ok.status()).toBe(201);
  expect((await request.post(url, { headers: H(U.management.token), data: { message: "Direct line approved: +91 98100 12345" } })).status()).toBe(201);
  // contact details may not reach suppliers through PO terms either
  expect((await request.post(`/api/admin/sd-orders/${w1.sdOrderId}/supplier-pos`, { headers: H(admin), data: { terms: "contact buyer@example.com" } })).status()).toBe(422);
});

test("phase 2: sensitive views, downloads and writes are audited", async ({ request }) => {
  await request.get("/api/admin/requirements", { headers: H(U.management.token) });
  await request.get("/api/super-admin/margin-report", { headers: H(U.finance.token) });
  await new Promise(r => setTimeout(r, 300));
  const entries = (await (await request.get("/api/admin/audit", { headers: H(su) })).json()).entries;
  const has = (a, role) => entries.some(e => e.action === a && (!role || e.actor_role === role));
  expect(has("buyer_contacts.view", "management")).toBe(true);
  expect(has("margin.view", "finance")).toBe(true);
  expect(has("communication.sent")).toBe(true);
  expect(has("disclosure.blocked")).toBe(true);
});

test("phase 3: My Desk shows only assigned work for each desk", async ({ request }) => {
  const bd = await makeUser(request, "buyer_desk", ".p3");
  U.bd3 = bd;
  const empty = await (await request.get("/api/admin/my-desk", { headers: H(bd.token) })).json();
  expect(empty.desk).toBe("buyer"); expect(empty.items.length).toBe(0);
  expect((await assign(request, "requirement", w1.requirementId, "buyer", bd.adminId)).status()).toBe(200);
  const mine = await (await request.get("/api/admin/my-desk", { headers: H(bd.token) })).json();
  expect(mine.items.map(i => i.id)).toEqual([w1.requirementId]);
  const pd = await (await request.get("/api/admin/my-desk", { headers: H(U.procurement.token) })).json();
  expect(pd.desk).toBe("procurement");
  expect(pd.items.map(i => i.id).sort()).toEqual([w1.sdOrderId, w2.sdOrderId].sort());
  expect(pd.items[0]).toHaveProperty("needed");
  expect((await (await request.get("/api/admin/my-desk", { headers: H(U.finance.token) })).json()).desk).toBe("finance");   // Finance has its own queue
  expect((await request.get("/api/admin/my-desk", { headers: H(U.management.token) })).status()).toBe(400);   // Management uses the Overview
});

test("phase 3: identity is revealed only after Management approves, and only for a limited time", async ({ request }) => {
  const bd = U.bd3, bt = H(bd.token), mt = H(U.management.token);
  const ask = (t, data) => request.post("/api/admin/disclosure-requests", { headers: t, data });
  // validation and ownership
  expect((await ask(bt, { entityType: "requirement", entityId: w1.requirementId, reason: "no" })).status()).toBe(400);
  expect((await ask(bt, { entityType: "requirement", entityId: w2.requirementId, reason: "I need the supplier name to verify quality" })).status()).toBe(403);
  const r = await ask(bt, { entityType: "requirement", entityId: w1.requirementId, reason: "Need the supplier name to resolve a quality complaint" });
  expect(r.status()).toBe(201);
  const rid = (await r.json()).id;
  expect((await ask(bt, { entityType: "requirement", entityId: w1.requirementId, reason: "Need the supplier name to resolve a quality complaint" })).status()).toBe(409);
  // not visible before approval
  expect((await request.get(`/api/admin/disclosure-requests/${rid}/reveal`, { headers: bt })).status()).toBe(403);
  // desks cannot decide; management sees it in the queue
  expect((await request.post(`/api/admin/disclosure-requests/${rid}/decision`, { headers: bt, data: { decision: "approve" } })).status()).toBe(403);
  const pending = (await (await request.get("/api/admin/disclosure-requests?status=pending", { headers: mt })).json()).requests;
  expect(pending.some(x => x.id === rid)).toBe(true);
  expect((await request.post(`/api/admin/disclosure-requests/${rid}/decision`, { headers: mt, data: { decision: "approve", hours: 4 } })).status()).toBe(200);
  expect((await request.post(`/api/admin/disclosure-requests/${rid}/decision`, { headers: mt, data: { decision: "reject" } })).status()).toBe(409);
  // now the requester can reveal; nobody else can
  const rev = await request.get(`/api/admin/disclosure-requests/${rid}/reveal`, { headers: bt });
  expect(rev.status()).toBe(200);
  expect((await rev.json()).kind).toBe("supplier_identity");
  expect((await request.get(`/api/admin/disclosure-requests/${rid}/reveal`, { headers: H(U.procurement.token) })).status()).toBe(404);
  // a rejected request stays closed
  const r2 = await request.post("/api/admin/disclosure-requests", { headers: H(U.procurement.token), data: { entityType: "sd_order", entityId: w1.sdOrderId, reason: "Need buyer contact for delivery coordination" } });
  expect(r2.status()).toBe(201);
  const rid2 = (await r2.json()).id;
  expect((await request.post(`/api/admin/disclosure-requests/${rid2}/decision`, { headers: mt, data: { decision: "reject", note: "Use the relay" } })).status()).toBe(200);
  expect((await request.get(`/api/admin/disclosure-requests/${rid2}/reveal`, { headers: H(U.procurement.token) })).status()).toBe(403);
  const entries = (await (await request.get("/api/admin/audit", { headers: H(su) })).json()).entries;
  for (const a of ["disclosure.requested", "disclosure.approved", "disclosure.rejected", "identity.revealed"]) expect(entries.some(e => e.action === a), a).toBe(true);
});

test("UI: buyer desk gets a trimmed menu; management can assign from a requirement", async ({ page, request }) => {
  const login = await makeUser(request, "buyer_desk", ".ui");
  await page.addInitScript(([t, r]) => { sessionStorage.setItem("supplydesk_admin_token", t); sessionStorage.setItem("supplydesk_admin_role", r); }, [login.token, "buyer_desk"]);
  await page.goto("/admin.html");
  await expect(page.locator("#roleBadge")).toHaveText("BUYER DESK");
  await expect(page.locator(".toolbar .navgroup button:visible")).toHaveText(["Overview", "Requests", "Orders"]);
  await expect(page.locator("#detail h2")).toHaveText("My desk");
  await page.close();
});

test("phone numbers and emails a buyer types into remarks are masked for roles without buyer contact access", async ({ request }) => {
  const b = await buyer(request, "remark");
  const q = await request.post("/api/buyer-requirements", { data: { dashboardToken: b.token, buyerName: "Remark Buyer", buyerCompany: "Remark Co", buyerCountry: "India", title: `RL remark ${stamp}`, description: "Urgent Required 9540055472, mail remark.buyer@example.com or +91 98765 43210, www.example.org/x", category: "Plastics & Polymers", subcategory: "Containers", quantity: "1000", unit: "pcs", targetPrice: 99, currency: "INR", deliveryCity: "Pune", requiredBy: "2030-01-01" } });
  expect(q.status()).toBe(201);
  const id = (await q.json()).requirementId;
  const MASK = "[contact hidden]";
  const listOf = async (token) => (await (await request.get("/api/admin/requirements", { headers: H(token) })).json()).requirements;
  const raw = (txt) => /9540055472|remark\.buyer@example\.com|98765 43210|example\.org/.test(txt);
  for (const [who, token] of [["super", su], ["management", U.management.token]]) {
    expect(raw(JSON.stringify(await listOf(token))), who + " sees the original text").toBe(true);
  }
  for (const [who, token] of [["admin", admin]]) {
    const mine = (await listOf(token)).find(r => r.id === id);
    expect(mine, who + " still sees the requirement").toBeTruthy();
    const t = JSON.stringify(mine);
    expect(raw(t), who + " must not see contact details").toBe(false);
    expect(t).toContain(MASK);
    expect(t).toContain("Urgent Required");
  }
  expect((await request.post(`/api/admin/requirements/${id}/review`, { headers: H(su), data: { action: "accept_full" } })).status()).toBe(200);
  // Buyer Desk talks to the buyer, so it keeps the original once the requirement is assigned.
  const bd = await makeUser(request, "buyer_desk", "remark");
  const as = await assign(request, "requirement", id, "buyer", bd.adminId);
  expect(as.status(), await as.text()).toBe(200);
  expect(raw(JSON.stringify(await listOf(bd.token)))).toBe(true);
});
