const { test, expect } = require("@playwright/test");
const RFQ = require("../../rfq");
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;

test("order architecture rules (pure)", () => {
  expect(RFQ.STAGES.map(s => s.label)).toEqual(["Order Received", "SupplyDesk Accepted", "Production Confirmed", "Material in Production", "Production Completed", "QC Completed", "Ready for Transport", "Transport Booked", "Insurance Completed", "In Transit", "Out for Delivery", "Delivered", "Order Closed"]);
  expect(RFQ.autoStageFromPos([])).toBe(null);
  expect(RFQ.autoStageFromPos(["issued"])).toBe(null);
  expect(RFQ.autoStageFromPos(["accepted", "in_production"])).toBe("production_confirmed");   // slowest PO wins
  expect(RFQ.autoStageFromPos(["in_production", "ready_for_qc"])).toBe("in_production");
  expect(RFQ.autoStageFromPos(["ready_for_qc", "dispatched"])).toBe("production_completed");
  expect(RFQ.manualStageProblem("supplydesk_accepted", "in_production", [])).toMatch(/automatically/);
  expect(RFQ.manualStageProblem("production_completed", "ready_for_transport", ["ready_for_dispatch"])).toMatch(/next step/i);
  expect(RFQ.manualStageProblem("production_completed", "qc_completed", [])).toBe(null);
  expect(RFQ.manualStageProblem("qc_completed", "ready_for_transport", ["ready_for_qc"])).toMatch(/ready for dispatch/);
  expect(RFQ.legacyStatusForStage("in_transit")).toBe("shipped");
  expect(RFQ.canPoTransition("issued", "partially_accepted")).toBe(true);
  expect(RFQ.canPoTransition("in_production", "ready_for_qc")).toBe(true);
  expect(RFQ.canPoTransition("ready_for_qc", "ready_for_dispatch")).toBe(true);
  expect(RFQ.newSdNumber()).toMatch(/^SD-\d{6}-[A-Z0-9]{4}$/);
});

test.describe("Buyer PO -> SupplyDesk order -> Supplier PO", () => {
  test.skip(!KEY || !AID || !APW, "needs E2E_TEST_KEY and admin env");
  // One sign-in per account for the whole file (the admin login endpoint is rate limited to 30 per 15 minutes).
  const sessions = {};
  const login = async (request, id, pw) => sessions[id] || (sessions[id] = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json()).token });

  async function placeOrder(request, ah, qty, tag) {
    const email = `of-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const bh = { "x-buyer-dashboard-token": v.dashboardToken };
    const { requirementId } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "Hidden Buyer " + tag, buyerCompany: "Hidden Buyer Co " + tag, buyerCountry: "India", title: "OF " + tag + " " + Date.now(), description: "d", category: "Plastics & Polymers", subcategory: "Containers", quantity: String(qty), unit: "pcs" } })).json();
    await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: 50, quantity: qty + " pcs" } });
    const acc = await (await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: bh, data: { decision: "accept" } })).json();
    return { orderId: acc.orderId, poNumber: acc.poNumber, bh, requirementId };
  }
  async function supplierHeaders(request) {
    const email = "supplier-e2e@example.com";
    const r = await (await request.post("/api/supplier-dashboard/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/supplier-dashboard/verify-otp", { data: { email, otp: r.testOtp } })).json();
    return { "x-supplier-dashboard-token": v.token };
  }
  const review = (request, ah, id, data) => request.post(`/api/admin/orders/${id}/review`, { headers: ah, data });
  const buyerOrder = async (request, o) => (await (await request.get("/api/buyer-orders", { headers: o.bh })).json()).orders.find(x => x.id === o.orderId);

  test("buyer order enters as Pending Review; review decisions; nothing is fulfilled before acceptance", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const o = await placeOrder(request, ah, 500, "rv");
    let b = await buyerOrder(request, o);
    expect([b.reviewStatus, b.stage, b.reviewLabel]).toEqual(["pending_review", "order_received", "Pending Review"]);
    expect(b.timeline.length).toBe(13);
    expect(b.timeline[0].state).toBe("current");

    // not accepted yet: no supplier PO, no SD order, no invoice, no stage change
    const code = (await (await request.get("/api/products")).json()).products.find(x => x.name === "E2E Test Product").capabilityCode;
    expect((await request.post(`/api/admin/orders/${o.orderId}/supplier-po`, { headers: ah, data: { capabilityCode: code, quantity: "500", unitCost: 30 } })).status()).toBe(409);
    expect((await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [o.orderId] } })).status()).toBe(409);
    expect((await request.post(`/api/admin/orders/${o.orderId}/invoice`, { headers: ah, data: { gstRate: 18 } })).status()).toBe(409);
    expect((await request.post(`/api/admin/orders/${o.orderId}/stage`, { headers: ah, data: { stage: "qc_completed" } })).status()).toBe(409);

    // validation, auth
    expect((await review(request, ah, o.orderId, { decision: "maybe" })).status()).toBe(400);
    expect((await review(request, ah, o.orderId, { decision: "reject" })).status()).toBe(400);                       // note required
    expect((await review(request, ah, o.orderId, { decision: "partial", note: "less", acceptedQuantity: "900" })).status()).toBe(400);   // must be below requested
    expect((await request.post(`/api/admin/orders/${o.orderId}/review`, { headers: o.bh, data: { decision: "accept" } })).status()).toBeGreaterThanOrEqual(401);

    // clarification -> buyer replies -> back in review
    expect((await review(request, ah, o.orderId, { decision: "clarify", note: "Please confirm the delivery port" })).status()).toBe(200);
    b = await buyerOrder(request, o);
    expect([b.reviewStatus, b.review_note]).toEqual(["pending_clarification", "Please confirm the delivery port"]);
    expect((await request.post(`/api/buyer-orders/${o.orderId}/clarify`, { headers: o.bh, data: { note: "" } })).status()).toBe(400);
    expect((await request.post(`/api/buyer-orders/${o.orderId}/clarify`, { headers: { "x-buyer-dashboard-token": "nope" }, data: { note: "x" } })).status()).toBeGreaterThanOrEqual(401);
    expect((await request.post(`/api/buyer-orders/${o.orderId}/clarify`, { headers: o.bh, data: { note: "Nhava Sheva" } })).status()).toBe(200);
    expect((await buyerOrder(request, o)).reviewStatus).toBe("pending_review");
    expect((await request.post(`/api/buyer-orders/${o.orderId}/clarify`, { headers: o.bh, data: { note: "again" } })).status()).toBe(409);

    // partial acceptance rewrites quantity and total, keeps the original request
    expect((await review(request, ah, o.orderId, { decision: "partial", note: "Capacity limit", acceptedQuantity: "300" })).status()).toBe(200);
    b = await buyerOrder(request, o);
    expect([b.reviewStatus, b.quantity, b.requested_quantity, Number(b.total_price), b.stage]).toEqual(["partially_accepted", "300", "500 pcs", 15000, "supplydesk_accepted"]);
    expect((await review(request, ah, o.orderId, { decision: "accept" })).status()).toBe(409);                      // decided already

    // rejected orders leave the pipeline
    const r = await placeOrder(request, ah, 100, "rj");
    expect((await review(request, ah, r.orderId, { decision: "reject", note: "Out of scope" })).status()).toBe(200);
    const rb = await buyerOrder(request, r);
    expect([rb.reviewStatus, rb.status, rb.timeline.length]).toEqual(["rejected", "cancelled", 0]);
    expect((await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [r.orderId] } })).status()).toBe(409);

    const audit = (await (await request.get(`/api/admin/audit?entity=order&id=${o.orderId}`, { headers: ah })).json()).entries.map(a => a.action);
    expect(audit).toEqual(expect.arrayContaining(["order.created", "order.reviewed", "order.clarification_reply"]));
  });

  test("3 buyer orders -> 1 SupplyDesk order -> 1 supplier PO; supplier confirmation drives the buyer timeline; full trace", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const [b1, b2, b3] = [await placeOrder(request, ah, 400, "a"), await placeOrder(request, ah, 300, "b"), await placeOrder(request, ah, 300, "c")];
    expect((await review(request, ah, b1.orderId, { decision: "accept" })).status()).toBe(200);
    expect((await review(request, ah, b2.orderId, { decision: "partial", note: "capacity", acceptedQuantity: "250" })).status()).toBe(200);
    expect((await review(request, ah, b3.orderId, { decision: "accept" })).status()).toBe(200);

    // SupplyDesk decides to combine them
    expect((await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [] } })).status()).toBe(400);
    const sd = await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [b1.orderId, b2.orderId, b3.orderId], title: "E2E combined run" } });
    expect(sd.status()).toBe(201);
    const { sdOrderId, sdNumber } = await sd.json();
    expect(sdNumber).toMatch(/^SD-/);
    expect((await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [b1.orderId] } })).status()).toBe(409);   // already in an SD order

    const code = (await (await request.get("/api/products")).json()).products.find(x => x.name === "E2E Test Product").capabilityCode;
    const sh = await supplierHeaders(request);
    const po = (data) => request.post(`/api/admin/sd-orders/${sdOrderId}/supplier-pos`, { headers: ah, data });
    expect((await po({ capabilityCode: code, unitCost: 0 })).status()).toBe(400);
    expect((await po({ capabilityCode: code, unitCost: 30, allocations: [{ buyerOrderId: b1.orderId, quantity: 999 }] })).status()).toBe(409);   // more than the order needs
    expect((await po({ capabilityCode: code, unitCost: 30, allocations: [{ buyerOrderId: "not-in-this-sd", quantity: 1 }] })).status()).toBe(400);
    expect((await request.post(`/api/admin/sd-orders/${sdOrderId}/supplier-pos`, { headers: sh, data: { capabilityCode: code, unitCost: 30 } })).status()).toBeGreaterThanOrEqual(401);

    const issued = await po({ capabilityCode: code, unitCost: 30, deliveryBy: "2030-01-01" });   // no allocations = everything still unallocated, combined
    expect(issued.status()).toBe(201);
    const { poNumber, supplierPoId, quantity } = await issued.json();
    expect(quantity).toBe("950");                                    // 400 + 250 + 300
    expect(poNumber).toMatch(/^SPO-/);
    expect((await po({ capabilityCode: code, unitCost: 30 })).status()).toBe(409);                  // nothing left to allocate

    // permanent mapping: every buyer PO traces to the same SD order and the exact supplier PO, with its own quantity
    const detail = await (await request.get(`/api/admin/sd-orders/${sdOrderId}`, { headers: ah })).json();
    expect(detail.sdOrder.sd_number).toBe(sdNumber);
    expect(detail.supplierPos.length).toBe(1);
    expect(detail.supplierPos[0].lines.map(l => [l.buyerPo, l.quantity]).sort()).toEqual([[b1.poNumber, 400], [b2.poNumber, 250], [b3.poNumber, 300]].sort());
    for (const b of [b1, b2, b3]) {
      const t = await (await request.get(`/api/admin/orders/${b.orderId}/trace`, { headers: ah })).json();
      expect(t.sdOrder.sd_number).toBe(sdNumber);
      expect(t.supplierPos.map(p => p.po_number)).toEqual([poNumber]);
      expect(t.buyerOrder.po_number).toBe(b.poNumber);
    }
    expect((await (await request.get(`/api/admin/orders/${b2.orderId}/trace`, { headers: ah })).json()).supplierPos[0].line_quantity).toBe("250.00");

    // supplier sees SupplyDesk as the source: one PO, no buyer, no buyer PO numbers, no buyer price
    const mine = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).json()).purchaseOrders.find(p => p.id === supplierPoId);
    expect(mine.quantity).toBe("950");
    const sj = JSON.stringify(mine);
    for (const b of [b1, b2, b3]) expect(sj).not.toContain(b.poNumber);
    expect(sj).not.toMatch(/Hidden Buyer|@example\.com|buyer|50\.0000/i);

    // issued only: the buyer timeline has NOT moved, and SupplyDesk cannot fake production steps
    for (const b of [b1, b2, b3]) expect((await buyerOrder(request, b)).stage).toBe("supplydesk_accepted");
    for (const stage of ["production_confirmed", "in_production", "qc_completed", "delivered"]) expect((await request.post(`/api/admin/orders/${b1.orderId}/stage`, { headers: ah, data: { stage } })).status()).toBe(409);
    expect((await request.patch(`/api/admin/orders/${b1.orderId}/status`, { headers: ah, data: { status: "in_production" } })).status()).toBe(409);   // legacy shortcut closed

    const sup = (status, data = {}) => request.patch(`/api/supplier-dashboard/purchase-orders/${supplierPoId}/status`, { headers: sh, data: { status, ...data } });
    expect((await sup("in_production")).status()).toBe(409);                                         // must acknowledge first
    expect((await sup("declined")).status()).toBe(400);                                              // reason needed
    expect((await sup("partially_accepted")).status()).toBe(400);                                    // quantity needed
    expect((await sup("partially_accepted", { acceptedQuantity: "950" })).status()).toBe(400);       // that is a full accept
    expect((await sup("accepted", { note: "ok" })).status()).toBe(200);
    for (const b of [b1, b2, b3]) expect((await buyerOrder(request, b)).stageLabel).toBe("Production Confirmed");
    expect((await sup("in_production", { batchNo: "BATCH-77", expectedCompletion: "not-a-date" })).status()).toBe(400);
    expect((await sup("in_production", { batchNo: "BATCH-77", expectedCompletion: "2030-02-01" })).status()).toBe(200);
    for (const b of [b1, b2, b3]) expect((await buyerOrder(request, b)).stageLabel).toBe("Material in Production");
    expect((await request.patch(`/api/supplier-dashboard/purchase-orders/${supplierPoId}/schedule`, { headers: sh, data: { expectedCompletion: "2030-02-15" } })).status()).toBe(200);
    expect((await sup("ready_for_qc")).status()).toBe(200);
    for (const b of [b1, b2, b3]) expect((await buyerOrder(request, b)).stageLabel).toBe("Production Completed");
    const live = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).json()).purchaseOrders.find(p => p.id === supplierPoId);
    expect([live.batch_no, String(live.expected_completion).slice(0, 10), live.production_started_at != null]).toEqual(["BATCH-77", "2030-02-15", true]);

    // SupplyDesk steps, strictly in order, gated on QC and on the supplier being ready to dispatch
    const stage = (id, s, extra = {}) => request.post(`/api/admin/orders/${id}/stage`, { headers: ah, data: { stage: s, ...extra } });
    expect((await stage(b1.orderId, "ready_for_transport")).status()).toBe(409);                    // QC first
    expect((await stage(b1.orderId, "qc_completed")).status()).toBe(200);
    expect((await stage(b1.orderId, "ready_for_transport")).status()).toBe(409);                    // supplier not ready for dispatch yet
    expect((await sup("ready_for_dispatch")).status()).toBe(200);
    expect((await stage(b1.orderId, "in_transit")).status()).toBe(409);                             // cannot skip steps
    expect((await stage(b1.orderId, "bogus")).status()).toBe(400);
    expect((await request.post(`/api/admin/orders/${b1.orderId}/stage`, { headers: b1.bh, data: { stage: "ready_for_transport" } })).status()).toBeGreaterThanOrEqual(401);   // buyers cannot drive the timeline
    const refs = { transport_booked: "BKG-123", insurance_completed: "INS-9", in_transit: "TRK-555" };
    for (const s of ["ready_for_transport", "transport_booked", "insurance_completed", "in_transit", "out_for_delivery", "delivered", "order_closed"]) {
      const r = await stage(b1.orderId, s, refs[s] ? { ref: refs[s] } : {});
      expect(r.status(), s).toBe(200);
      expect((await buyerOrder(request, b1)).stage).toBe(s);
    }
    // the other two are tracked independently
    expect((await buyerOrder(request, b2)).stage).toBe("production_completed");
    const done = await buyerOrder(request, b1);
    expect(done.status).toBe("delivered");
    expect(done.timeline.every(t => t.state !== "todo")).toBe(true);
    expect(done.timeline.find(t => t.key === "transport_booked").ref).toBe("BKG-123");

    // the buyer never sees the supplier, a supplier PO or a batch
    const buyerJson = JSON.stringify([await (await request.get("/api/buyer-orders", { headers: b1.bh })).json(), await (await request.get("/api/buyer-requirements", { headers: b1.bh })).json()]);
    expect(buyerJson).not.toMatch(/SPO-|BATCH-77|supplier-e2e|India Growth|Supplier PO/i);
    expect(buyerJson).toContain("Production Completed");

    // full trace for the delivered order, supplier identity for Super Admin only
    const t = await (await request.get(`/api/admin/orders/${b1.orderId}/trace`, { headers: ah })).json();
    expect(t.delivered).toBe(true);
    expect(t.supplierPos[0].batch_no).toBe("BATCH-77");
    expect(t.shipment.map(s => [s.stage, s.ref])).toEqual(expect.arrayContaining([["transport_booked", "BKG-123"], ["in_transit", "TRK-555"], ["delivered", null]]));
    expect(JSON.stringify(t)).not.toMatch(/India Growth|supplier-e2e@example\.com|Hidden Buyer/);
    if (SID && SPW) {
      const sa = await login(request, SID, SPW);
      const ts = await (await request.get(`/api/admin/orders/${b1.orderId}/trace`, { headers: sa })).json();
      expect(JSON.stringify(ts)).toMatch(/India Growth/);
      expect(JSON.stringify(ts)).toMatch(/Hidden Buyer/);
    }
  });

  test("declined supplier PO frees the quantity; partial supplier acceptance leaves a shortfall to re-source", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const b = await placeOrder(request, ah, 600, "sf");
    expect((await review(request, ah, b.orderId, { decision: "accept" })).status()).toBe(200);
    const sd = await (await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [b.orderId] } })).json();
    const code = (await (await request.get("/api/products")).json()).products.find(x => x.name === "E2E Test Product").capabilityCode;
    const sh = await supplierHeaders(request);
    const issue = (qty) => request.post(`/api/admin/sd-orders/${sd.sdOrderId}/supplier-pos`, { headers: ah, data: { capabilityCode: code, unitCost: 20, allocations: [{ buyerOrderId: b.orderId, quantity: qty }] } });
    const p1 = await (await issue(400)).json();
    const items = async () => (await (await request.get(`/api/admin/sd-orders/${sd.sdOrderId}`, { headers: ah })).json()).items[0];
    expect((await items()).remaining).toBe(200);
    // partial: 400 ordered, supplier takes 300 -> 300 still to source and the buyer timeline stays put
    expect((await request.patch(`/api/supplier-dashboard/purchase-orders/${p1.supplierPoId}/status`, { headers: sh, data: { status: "partially_accepted", acceptedQuantity: "300", note: "short" } })).status()).toBe(200);
    expect((await items()).remaining).toBe(300);
    expect((await buyerOrder(request, b)).stage).toBe("supplydesk_accepted");
    // supplier rejects entirely -> the whole quantity is free again, and is still traceable as history
    expect((await request.patch(`/api/admin/supplier-pos/${p1.supplierPoId}/cancel`, { headers: ah, data: { note: "re-source" } })).status()).toBe(200);
    expect((await items()).remaining).toBe(600);
    const p2 = await issue(600);
    expect(p2.status()).toBe(201);
    const trace = await (await request.get(`/api/admin/orders/${b.orderId}/trace`, { headers: ah })).json();
    expect(trace.supplierPos.map(p => p.status).sort()).toEqual(["cancelled", "issued"]);   // the cancelled PO stays on record
  });
});
