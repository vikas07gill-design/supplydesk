const { test, expect } = require("@playwright/test");
const RFQ = require("../../rfq");
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;

test("invoice maths uses integer paise and validates rates", () => {
  expect(RFQ.computeInvoice(12500, 18)).toEqual({ subtotal: 12500, gst: 2250, total: 14750 });
  expect(RFQ.computeInvoice(100.1, 5)).toEqual({ subtotal: 100.1, gst: 5.01, total: 105.11 });
  expect(RFQ.computeInvoice(0, 5)).toBeNull();
  expect(RFQ.computeInvoice(10, 40)).toBeNull();
  expect(RFQ.invoiceStatus(100, 0)).toBe("issued");
  expect(RFQ.invoiceStatus(100, 40)).toBe("partially_paid");
  expect(RFQ.invoiceStatus(100, 100)).toBe("paid");
});

test.describe("invoice and payments", () => {
  test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and admin env");
  test("issue, partial then full payment, overpay blocked, void rules, buyer isolation", async ({ request }) => {
    const ah = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json()).token };
    const mk = async () => {
      const email = `p5-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
      const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
      const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
      return { bh: { "x-buyer-dashboard-token": v.dashboardToken }, token: v.dashboardToken };
    };
    const buyer = await mk(), other = await mk();
    const { requirementId } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: buyer.token, buyerName: "P5", buyerCountry: "India", title: "P5 " + Date.now(), description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "1000", unit: "pcs" } })).json();
    await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: 12.5, quantity: "1000 pcs" } });
    const { orderId } = await (await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: buyer.bh, data: { decision: "accept" } })).json();
    await request.post(`/api/admin/orders/${orderId}/review`, { headers: ah, data: { decision: "accept" } });

    expect((await request.post(`/api/admin/orders/${orderId}/invoice`, { headers: buyer.bh, data: { gstRate: 18 } })).status()).toBeGreaterThanOrEqual(401);
    expect((await request.post(`/api/admin/orders/${orderId}/invoice`, { headers: ah, data: { gstRate: 40 } })).status()).toBe(400);
    const inv = await request.post(`/api/admin/orders/${orderId}/invoice`, { headers: ah, data: { gstRate: 18, dueDate: "2030-01-31" } });
    expect(inv.status()).toBe(201);
    const ij = await inv.json();
    expect(ij.invoiceNo).toMatch(/^INV-\d{6}-[A-Z0-9]{4}$/);
    expect([ij.subtotal, ij.gst, ij.total]).toEqual([12500, 2250, 14750]);
    expect((await request.post(`/api/admin/orders/${orderId}/invoice`, { headers: ah, data: { gstRate: 18 } })).status()).toBe(409);   // one active invoice

    const pay = (amount, extra = {}) => request.post(`/api/admin/invoices/${ij.invoiceId}/payments`, { headers: ah, data: { amount, method: "bank_transfer", reference: "UTR1", ...extra } });
    expect((await pay(0)).status()).toBe(400);
    expect((await pay(100, { method: "bitcoin" })).status()).toBe(400);
    expect((await pay(100, { receivedOn: "2099-01-01" })).status()).toBe(400);
    expect((await pay(15000)).status()).toBe(400);                       // overpayment
    expect((await (await pay(5000)).json()).status).toBe("partially_paid");
    expect((await request.patch(`/api/admin/invoices/${ij.invoiceId}/void`, { headers: ah, data: {} })).status()).toBe(409);   // has payments
    const last = await (await pay(9750)).json();
    expect(last.status).toBe("paid");
    expect((await pay(1)).status()).toBe(409);                           // fully paid

    const mine = (await (await request.get("/api/buyer-invoices", { headers: buyer.bh })).json()).invoices;
    expect(mine[0].status).toBe("paid");
    expect(mine[0].outstanding).toBe(0);
    expect(mine[0].payments.length).toBe(2);
    expect((await (await request.get("/api/buyer-invoices", { headers: other.bh })).json()).invoices.length).toBe(0);

    const admin = (await (await request.get(`/api/admin/orders/${orderId}/invoice`, { headers: ah })).json()).invoices[0];
    expect(Number(admin.paid_amount)).toBe(14750);
    const audit = (await (await request.get(`/api/admin/audit?entity=invoice&id=${ij.invoiceId}`, { headers: ah })).json()).entries.map(a => a.action);
    expect(audit).toContain("invoice.issued");
    expect(audit.filter(a => a === "payment.recorded").length).toBe(2);
  });

  test("an unpaid invoice can be voided and re-issued", async ({ request }) => {
    const ah = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: AID, password: APW } })).json()).token };
    const email = `p5v-${Date.now()}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const bh = { "x-buyer-dashboard-token": v.dashboardToken };
    const { requirementId } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "P5", buyerCountry: "India", title: "P5v " + Date.now(), description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: "100", unit: "pcs" } })).json();
    await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: 10, quantity: "100 pcs" } });
    const { orderId } = await (await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: bh, data: { decision: "accept" } })).json();
    await request.post(`/api/admin/orders/${orderId}/review`, { headers: ah, data: { decision: "accept" } });
    const a = await (await request.post(`/api/admin/orders/${orderId}/invoice`, { headers: ah, data: { gstRate: 5 } })).json();
    expect((await request.patch(`/api/admin/invoices/${a.invoiceId}/void`, { headers: ah, data: { note: "wrong GST" } })).status()).toBe(200);
    expect((await (await request.get("/api/buyer-invoices", { headers: bh })).json()).invoices.length).toBe(0);   // void hidden from buyer
    expect((await request.post(`/api/admin/orders/${orderId}/invoice`, { headers: ah, data: { gstRate: 18 } })).status()).toBe(201);
  });
});
