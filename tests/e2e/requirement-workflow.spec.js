const { test, expect } = require("@playwright/test");
// Needs a server with E2E_TEST_MODE+E2E_TEST_KEY (testOtp) and admin creds; skipped otherwise.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and E2E_ADMIN_ID/E2E_ADMIN_PASSWORD");

test("requirement is held for admin review, then shared, tracked by buyer, and can be rejected", async ({ request }) => {
  const email = `req-${Date.now()}@example.com`;
  const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
  const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
  const bh = { "x-buyer-dashboard-token": v.dashboardToken };
  const sub = await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "T", buyerCountry: "India", title: "WF " + Date.now(), description: "d", category: "Plastics & Polymers", subcategory: "Containers" } });
  expect(sub.status()).toBe(201);
  const { requirementId } = await sub.json();
  let mine = (await (await request.get("/api/buyer-requirements", { headers: bh })).json()).requirements;
  expect(mine[0].status).toBe("pending_review");
  // buyer cannot self-publish
  expect((await request.patch("/api/buyer-requirements/" + requirementId, { headers: bh, data: { status: "open" } })).status()).toBe(400);

  const login = await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json();
  const ah = { "x-admin-token": login.token };
  const rv = await request.post(`/api/admin/requirements/${requirementId}/review`, { headers: ah, data: { action: "share_suppliers", supplierIds: [] } });
  expect(rv.status()).toBe(400); // must pick suppliers
  const rej = await request.post(`/api/admin/requirements/${requirementId}/review`, { headers: ah, data: { action: "reject", buyerNote: "not genuine" } });
  expect(rej.status()).toBe(200);
  mine = (await (await request.get("/api/buyer-requirements", { headers: bh })).json()).requirements;
  expect(mine[0].status).toBe("rejected");
  expect(mine[0].buyer_note).toBe("not genuine");
});
