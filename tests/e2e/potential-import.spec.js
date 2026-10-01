import { test, expect } from "@playwright/test";

// Needs a local server started with ADMIN_ID/ADMIN_PASSWORD (no emails are sent here).
const adminId = process.env.E2E_ADMIN_ID, adminPassword = process.env.E2E_ADMIN_PASSWORD;
test.describe("Potential contacts import", () => {
  test.skip(!adminId || !adminPassword, "set E2E_ADMIN_ID and E2E_ADMIN_PASSWORD");
  test("import stores contacts as new, skips duplicates by email/mobile, rejects oversize batches", async ({ request }) => {
    const login = await request.post("/api/admin/login", { data: { adminId, password: adminPassword } });
    const headers = { "x-admin-token": (await login.json()).token };
    const tag = Date.now();
    const digits = "9" + String(tag).slice(-9);
    const rec = { name: "Spec Co", email: `spec${tag}@example.test`, phone: `+91 ${digits}` };
    const post = data => request.post("/api/admin/potential-contacts/import", { headers, data: { inviteType: "supplier", recipients: data } });
    const first = await (await post([rec])).json();
    expect(first.added).toBe(1);
    const dup = await (await post([{ ...rec, email: `SPEC${tag}@Example.test` }, { name: "Same mobile", email: `other${tag}@example.test`, phone: `0${digits.slice(0, 5)}-${digits.slice(5)}` }])).json();
    expect(dup.added).toBe(0);
    expect(dup.skipped).toBe(2);
    const list = await (await request.get(`/api/admin/potential-contacts?search=spec${tag}`, { headers })).json();
    expect(list.contacts[0].status).toBe("new");
    const big = await post(Array.from({ length: 501 }, (_, i) => ({ name: "x", email: `x${i}@e.test` })));
    expect(big.status()).toBe(400);
  });
});
