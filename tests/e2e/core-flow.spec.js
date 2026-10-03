const { test, expect } = require("@playwright/test");
// Core SupplyDesk model:  END BUYER -> SUPPLYDESK -> SUPPLIER.
// PUBLIC = SupplyDesk capability, INTERNAL = supplier allocation, SUPPLIER = SupplyDesk's customer.
const KEY = process.env.E2E_TEST_KEY, AID = process.env.E2E_ADMIN_ID, APW = process.env.E2E_ADMIN_PASSWORD;
const SID = process.env.E2E_SUPER_ID, SPW = process.env.E2E_SUPER_PASSWORD;
const SEED_SUPPLIER_ID = "00000000-0000-4000-8000-000000000002";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

test.describe("buyer signup (no documents)", () => {
  test.skip(!KEY, "needs E2E_TEST_KEY");
  test.use({ extraHTTPHeaders: { "x-e2e-key": KEY || "" } });

  test("buyer signup needs company, contact, mobile, country + email OTP; existing login is unchanged", async ({ request }) => {
    const email = `bs-${Date.now()}@example.com`;
    const full = { email, signup: true, company: "Acme Procurement", contact: "Asha Rao", phone: "+91 98765 43210", country: "India" };
    const ask = (d) => request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: d });
    for (const bad of [{ company: "" }, { contact: "" }, { phone: "abc" }, { country: "" }]) {
      expect((await ask({ ...full, ...bad })).status()).toBe(400);
    }
    const r = await ask(full);
    expect(r.status()).toBe(200);
    const { testOtp } = await r.json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { ...full, otp: testOtp } })).json();
    expect(v.ok).toBe(true);
    expect(v.newAccount).toBe(true);
    const me = await (await request.get("/api/buyer-dashboard", { headers: { "x-buyer-dashboard-token": v.dashboardToken } })).json();
    expect(me.buyer).toMatchObject({ email, company: "Acme Procurement", name: "Asha Rao", phone: "+91 98765 43210", country: "India" });

    // plain email-only login (old flow) still works, never overwrites the saved profile, and is not a "new account"
    const o2 = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v2 = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: o2.testOtp } })).json();
    expect(v2.ok).toBe(true);
    expect(v2.newAccount).toBe(false);
    const again = await (await request.get("/api/buyer-dashboard", { headers: { "x-buyer-dashboard-token": v2.dashboardToken } })).json();
    expect(again.buyer.company).toBe("Acme Procurement");

    // old email-only flow still creates an account (product page enquiry path)
    const email3 = `bs3-${Date.now()}@example.com`;
    const o3 = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email: email3 } })).json();
    expect((await request.post("/api/buyer-email/verify-otp", { data: { email: email3, otp: o3.testOtp } })).status()).toBe(200);
  });

  test("buyer-login page: signup mode shows the 4 profile fields, login mode does not", async ({ page }) => {
    await page.goto("/buyer-login.html");
    await expect(page.locator("#company")).toBeHidden();
    await expect(page.locator("#phone")).toBeHidden();
    await page.goto("/buyer-login.html?mode=signup");
    for (const id of ["#company", "#contact", "#email", "#phone", "#country"]) await expect(page.locator(id)).toBeVisible();
    await page.locator("#email").fill("x@example.com");
    await page.locator("#go").click();
    await expect(page.locator("#st")).toContainText(/company/i);
  });

  test("buyer signup page end to end opens the dashboard with the saved profile", async ({ page }) => {
    const email = `bsui-${Date.now()}@example.com`;
    await page.goto("/buyer-login.html?mode=signup");
    await page.locator("#company").fill("UI Test Co");
    await page.locator("#contact").fill("Uma Test");
    await page.locator("#email").fill(email);
    await page.locator("#phone").fill("+91 90000 00001");
    await page.locator("#country").fill("India");
    await page.locator("#go").click();
    await expect(page.locator("#otp")).toHaveValue(/^\d{6}$/);   // test mode pre-fills the code
    await page.locator("#go").click();
    await expect(page).toHaveURL(/buyer-dashboard\.html/);
  });
});

test.describe("supplier onboarding, eligibility, privacy, allocation", () => {
  test.skip(!KEY || !AID || !APW || !SID || !SPW, "needs E2E_TEST_KEY and admin + super admin env");
  test.describe.configure({ mode: "serial" });

  const sessions = {};
  const login = async (request, id, pw) => sessions[id] || (sessions[id] = { "x-admin-token": (await (await request.post("/api/admin/login", { data: { adminId: id, password: pw } })).json()).token });
  const stamp = Date.now();
  const EMAIL = `onb-${stamp}@example.com`;
  const COMPANY = `Zenith Polymers ${stamp}`;
  const WIDGET = `Core Widget ${stamp}`;
  let sh;                // new supplier headers
  let seedH;             // seeded supplier headers
  let pid;               // new supplier profile id
  let newProductId, newCode, seedProductId, seedCode;

  async function supplierLogin(request, email) {
    const r = await (await request.post("/api/supplier-dashboard/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/supplier-dashboard/verify-otp", { data: { email, otp: r.testOtp } })).json();
    return { "x-supplier-dashboard-token": v.token };
  }
  async function placeOrder(request, ah, qty, tag) {
    const email = `cf-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const bh = { "x-buyer-dashboard-token": v.dashboardToken };
    const { requirementId } = await (await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "Hidden Buyer " + tag, buyerCompany: "Hidden Buyer Co " + tag, buyerCountry: "India", title: "Core flow " + tag, description: "Need widgets", specification: "std", certifications: "none", packaging: "carton", paymentTerms: "30% advance", incoterm: "FOB", category: "Plastics & Polymers", subcategory: "Containers", quantity: String(qty), unit: "pcs", requiredBy: "2030-01-01" } })).json();
    await request.post(`/api/admin/requirements/${requirementId}/buyer-quote`, { headers: ah, data: { unitPrice: 50, quantity: qty + " pcs" } });
    const acc = await (await request.post(`/api/buyer-requirements/${requirementId}/quote/respond`, { headers: bh, data: { decision: "accept" } })).json();
    return { orderId: acc.orderId, poNumber: acc.poNumber, bh };
  }
  const buyerOrder = async (request, o) => (await (await request.get("/api/buyer-orders", { headers: o.bh })).json()).orders.find(x => x.id === o.orderId);

  test("supplier signup: 5 fields + email OTP -> account -> dashboard; email OTP is not business verification", async ({ request }) => {
    const ask = (d) => request.post("/api/supplier-signup/request-otp", { headers: { "x-e2e-key": KEY }, data: d });
    const ok = { company: COMPANY, contact: "Ravi Menon", email: EMAIL, phone: "+91 98100 00000", country: "India" };
    for (const bad of [{ company: "" }, { contact: "" }, { email: "nope" }, { phone: "x" }, { country: "" }, { website_confirm: "bot" }]) {
      expect((await ask({ ...ok, ...bad })).status()).toBe(400);
    }
    const r = await ask(ok);
    expect(r.status()).toBe(200);
    const { testOtp } = await r.json();
    expect((await request.post("/api/supplier-signup/verify-otp", { data: { email: EMAIL, otp: testOtp === "000000" ? "111111" : "000000" } })).status()).toBe(400);
    const v = await request.post("/api/supplier-signup/verify-otp", { data: { email: EMAIL, otp: testOtp } });
    expect(v.status()).toBe(200);
    const body = await v.json();
    expect(body.onboardingStatus).toBe("account_verified");
    sh = { "x-supplier-dashboard-token": body.token };
    expect((await ask(ok)).status()).toBe(409);                    // account exists -> log in instead

    const dash = await (await request.get("/api/supplier-dashboard", { headers: sh })).json();
    expect(dash.supplier).toMatchObject({ legal_name: COMPANY, eligible: false, verified: false, onboardingStatus: "account_verified" });

    // dashboard works, but no live procurement API is open to an unapproved supplier
    for (const [method, url] of [["get", "/api/supplier-dashboard/requirements"], ["get", "/api/supplier-dashboard/purchase-orders"], ["post", "/api/supplier-dashboard/requirements/x/quote"], ["patch", "/api/supplier-dashboard/purchase-orders/x/status"], ["patch", "/api/supplier-dashboard/purchase-orders/x/schedule"], ["post", "/api/supplier-dashboard/requirements/x/view"]]) {
      const res = await request[method](url, { headers: sh, data: { status: "accepted", unitPrice: 1 } });
      expect(res.status(), url).toBe(403);
      expect((await res.json()).code).toBe("supplier_not_eligible");
    }
    // unapproved supplier is invisible publicly
    expect(JSON.stringify(await (await request.get("/api/products")).json())).not.toContain(COMPANY);
    // normal OTP login works for an unapproved account too
    const again = await supplierLogin(request, EMAIL);
    expect((await request.get("/api/supplier-dashboard/onboarding", { headers: again })).status()).toBe(200);
    // a signup does not create duplicates: same email can never sign up twice
    const dupe = await ask({ ...ok, company: "Other Name" });
    expect(dupe.status()).toBe(409);
  });

  test("8-step wizard saves step by step; submit needs the essentials; email OTP never counts as business verification", async ({ request }) => {
    const ob = async () => (await request.get("/api/supplier-dashboard/onboarding", { headers: sh })).json();
    let o = await ob();
    expect(o.steps.map(s => s.title)).toEqual(["Business details", "Legal / registration details", "Products & capabilities", "Capacity", "Lead time", "Certifications", "Business documents", "Factory / business photos"]);
    expect([o.status, o.completedCount, o.canSubmit]).toEqual(["account_verified", 0, false]);

    // 1 business
    const biz = { legalName: COMPANY, tradeName: "Zenith", businessType: "Manufacturer", yearEstablished: 2012, country: "India", city: "Rewari", address: "Plot 4, Industrial Area", website: "https://example.com", designation: "Director", category: "Plastics & Polymers", subcategory: "Containers" };
    expect((await request.put("/api/supplier-dashboard/onboarding/business", { headers: sh, data: { ...biz, category: "Nope" } })).status()).toBe(400);
    expect((await request.put("/api/supplier-dashboard/onboarding/business", { headers: sh, data: { ...biz, city: "" } })).status()).toBe(400);
    expect((await request.put("/api/supplier-dashboard/onboarding/business", { headers: sh, data: biz })).status()).toBe(200);
    // 2 legal
    expect((await request.put("/api/supplier-dashboard/onboarding/legal", { headers: sh, data: {} })).status()).toBe(400);
    expect((await request.put("/api/supplier-dashboard/onboarding/legal", { headers: sh, data: { registrationNumber: "U25200HR2012", taxNumber: "06ABCDE1234F1Z5" } })).status()).toBe(200);
    // not submittable yet: products + documents missing
    const early = await request.post("/api/supplier-dashboard/onboarding/submit", { headers: sh });
    expect(early.status()).toBe(400);
    expect((await early.json()).missing).toEqual(expect.arrayContaining(["Products & capabilities", "Business documents"]));
    // 3-5 product with capacity + lead time
    const add = await request.post("/api/supplier-dashboard/products", { headers: sh, data: { product_name: WIDGET, category: "Plastics & Polymers", subcategory: "Containers", moq: "10", unit: "pcs", monthly_capacity: 50000, available_capacity: 40000, capacity_unit: "pcs", lead_time_days: 30, origin_region: "Haryana" } });
    expect(add.status()).toBeLessThan(300);
    const prods = (await (await request.get("/api/supplier-dashboard/products", { headers: sh })).json()).products;
    newProductId = prods.find(p => p.product_name === WIDGET).id;
    newCode = prods.find(p => p.product_name === WIDGET).capability_code;
    // 7 + 8 documents and photos
    expect((await request.post("/api/supplier-dashboard/onboarding/files", { headers: sh, multipart: {} })).status()).toBe(400);
    expect((await request.post("/api/supplier-dashboard/onboarding/files", { headers: sh, multipart: { registrationDoc: { name: "reg.pdf", mimeType: "application/pdf", buffer: PDF } } })).status()).toBe(201);
    expect((await request.post("/api/supplier-dashboard/onboarding/files", { headers: sh, multipart: { businessPhotos: { name: "factory.png", mimeType: "image/png", buffer: PNG } } })).status()).toBe(201);
    o = await ob();
    expect(o.steps.filter(s => s.complete).map(s => s.n)).toEqual([1, 2, 3, 4, 5, 7, 8]);   // certifications still open
    expect((await request.put("/api/supplier-dashboard/onboarding/certifications", { headers: sh, data: { text: "", none: true } })).status()).toBe(200);
    o = await ob();
    expect(o.completedCount).toBe(8);
    expect([o.canSubmit, o.status]).toEqual([true, "account_verified"]);
    const delFile = o.files.find(f => f.file_type === "business_photo");
    expect((await request.delete("/api/supplier-dashboard/onboarding/files/not-a-file", { headers: sh })).status()).toBe(404);
    expect((await request.delete(`/api/supplier-dashboard/onboarding/files/${delFile.id}`, { headers: sh })).status()).toBe(200);
    expect((await request.post("/api/supplier-dashboard/onboarding/files", { headers: sh, multipart: { businessPhotos: { name: "factory.png", mimeType: "image/png", buffer: PNG } } })).status()).toBe(201);

    const sub = await request.post("/api/supplier-dashboard/onboarding/submit", { headers: sh });
    expect(sub.status()).toBe(200);
    expect((await sub.json()).status).toBe("business_verification_pending");
    expect((await request.post("/api/supplier-dashboard/onboarding/submit", { headers: sh })).status()).toBe(409);
    // submitting still does not unlock live orders
    expect((await request.get("/api/supplier-dashboard/requirements", { headers: sh })).status()).toBe(403);
  });

  test("admin state machine: invalid moves blocked; approval needs verified capacity + signed agreement; eligibility follows", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const list = (await (await request.get("/api/admin/applications", { headers: ah })).json()).applications;
    const me = list.find(a => a.business_email === EMAIL);
    expect(me.onboarding_status).toBe("business_verification_pending");
    pid = me.profile_id;
    const move = (status, extra = {}) => request.patch(`/api/admin/suppliers/${pid}/onboarding`, { headers: ah, data: { status, ...extra } });

    expect((await move("supplydesk_approved")).status()).toBe(409);                // cannot skip steps
    expect((await move("not_a_state")).status()).toBe(400);
    expect((await move("rejected")).status()).toBe(400);                           // reason required
    expect((await request.patch(`/api/admin/suppliers/${pid}/onboarding`, { headers: sh, data: { status: "business_verified" } })).status()).toBeGreaterThanOrEqual(401);   // supplier can't self-approve
    expect((await move("business_verified")).status()).toBe(200);
    expect((await move("capability_verification_pending")).status()).toBe(200);
    expect((await move("capability_verified")).status()).toBe(400);               // no verified product + capacity yet

    // product + capacity must be verified by SupplyDesk first
    expect((await request.post(`/api/admin/products/${newProductId}/capacity-verification`, { headers: ah, data: { verified: true } })).status()).toBe(400);   // approve product first
    expect((await request.patch(`/api/admin/products/${newProductId}`, { headers: ah, data: { status: "approved" } })).status()).toBe(200);
    expect((await request.post(`/api/admin/products/${newProductId}/capacity-verification`, { headers: ah, data: { verified: true } })).status()).toBe(200);
    expect((await move("capability_verified")).status()).toBe(200);
    expect((await move("supplydesk_approved")).status()).toBe(400);               // agreement not signed
    const approved = await move("supplydesk_approved", { agreementSigned: true, note: "All good" });
    expect(approved.status()).toBe(200);
    expect((await approved.json()).eligible).toBe(true);

    // now eligible: procurement APIs open
    expect((await request.get("/api/supplier-dashboard/requirements", { headers: sh })).status()).toBe(200);
    expect((await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).status()).toBe(200);
    const dash = await (await request.get("/api/supplier-dashboard", { headers: sh })).json();
    expect([dash.supplier.eligible, dash.supplier.onboardingStatus]).toEqual([true, "supplydesk_approved"]);
    // an approved profile changes through the review flow, not the wizard
    expect((await request.put("/api/supplier-dashboard/onboarding/legal", { headers: sh, data: { registrationNumber: "X" } })).status()).toBe(409);

    // history + detail for admin
    const detail = await (await request.get(`/api/admin/applications/${me.id}`, { headers: ah })).json();
    expect(detail.onboarding.status).toBe("supplydesk_approved");
    expect(detail.onboarding.events.length).toBeGreaterThanOrEqual(5);
    expect(detail.onboarding.products[0].capacity_verified).toBe(1);
  });

  test("public view merges suppliers into one SupplyDesk capability; only verified, free capacity counts; no supplier data", async ({ request }) => {
    const ah = await login(request, AID, APW);
    seedH = await supplierLogin(request, "supplier-e2e@example.com");
    // the seeded supplier offers the same capability
    expect((await request.post("/api/supplier-dashboard/products", { headers: seedH, data: { product_name: WIDGET, category: "Plastics & Polymers", subcategory: "Containers", moq: "10", unit: "pcs", monthly_capacity: 100000, available_capacity: 90000, capacity_unit: "pcs", lead_time_days: 20, origin_region: "Delhi" } })).status()).toBeLessThan(300);
    const sp = (await (await request.get("/api/supplier-dashboard/products", { headers: seedH })).json()).products.find(p => p.product_name === WIDGET);
    seedProductId = sp.id; seedCode = sp.capability_code;

    const cards = async () => (await (await request.get("/api/products", {})).json()).products.filter(p => p.name === WIDGET);
    // pending products are not public; approved-but-capacity-unverified shows the product with unknown capacity
    expect((await cards()).length).toBe(1);                                         // only the verified supplier's product
    expect((await cards())[0].capacity.available).toBe(null);                        // single supplier: never an exact figure
    expect((await request.patch(`/api/admin/products/${seedProductId}`, { headers: ah, data: { status: "approved" } })).status()).toBe(200);
    let c = await cards();
    expect(c.length).toBe(1);                                                        // one merged capability, not one card per supplier
    expect(c[0].capacity.status).not.toBe("unknown");                                // new supplier's verified capacity counts
    expect(c[0].capacity.band).toBe("10,000 - 50,000");                             // seed product capacity still unverified -> not counted
    expect((await request.post(`/api/admin/products/${seedProductId}/capacity-verification`, { headers: ah, data: { verified: true } })).status()).toBe(200);
    c = await cards();
    expect(c.length).toBe(1);
    expect(c[0].capacity.available).toBe(130000);                                    // 90,000 + 40,000, 2 suppliers
    expect(c[0].capacity.band).toBe("100,000 - 500,000");
    expect([c[0].capacity.leadTimeDays, c[0].capacity.leadTimeMaxDays]).toEqual([20, 30]);
    const detail = await (await request.get(`/api/products/${c[0].id}`)).json();
    for (const text of [JSON.stringify(c[0]), JSON.stringify(detail)]) {
      expect(text).not.toMatch(new RegExp(`Zenith|India Growth|${COMPANY}|Haryana|Delhi|supplierId|supplierName|example\\.com|90000|40000|150000|business_email`, "i"));
    }
    expect(c[0].id).toMatch(/^cap-/);
    expect(c[0].id).not.toBe(seedProductId);
    // old per-product links keep working but resolve to the same capability
    expect((await (await request.get(`/api/products/${seedProductId}`)).json()).product.id).toBe(c[0].id);
    expect((await request.get("/api/suppliers")).status()).toBe(200);
    expect((await (await request.get("/api/suppliers")).json()).suppliers).toEqual([]);
    expect((await request.get(`/api/suppliers/${SEED_SUPPLIER_ID}`)).status()).toBe(404);
  });

  test("supplier sees a SupplyDesk sourcing request, never buyer identity or target price; quotes go to SupplyDesk only", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const email = `pv-${Date.now()}@example.com`;
    const otp = await (await request.post("/api/buyer-email/request-otp", { headers: { "x-e2e-key": KEY }, data: { email } })).json();
    const v = await (await request.post("/api/buyer-email/verify-otp", { data: { email, otp: otp.testOtp } })).json();
    const bh = { "x-buyer-dashboard-token": v.dashboardToken };
    const sub = await request.post("/api/buyer-requirements", { data: { dashboardToken: v.dashboardToken, buyerName: "Secret Buyer", buyerCompany: "Secret Buyer Holdings", buyerCountry: "India", title: "Privacy RFQ " + stamp, description: "Need widgets", specification: "std", certifications: "none", packaging: "carton", paymentTerms: "30% advance", incoterm: "FOB", category: "Plastics & Polymers", subcategory: "Containers", quantity: "5000", unit: "pcs", targetPrice: 777.77, currency: "USD", deliveryCity: "Pune", requiredBy: "2030-01-01" } });
    expect(sub.status()).toBe(201);
    const { requirementId } = await sub.json();
    expect((await request.post(`/api/admin/requirements/${requirementId}/review`, { headers: ah, data: { action: "share_suppliers", supplierIds: [SEED_SUPPLIER_ID, pid] } })).status()).toBe(200);

    for (const h of [sh, seedH]) {
      const mine = (await (await request.get("/api/supplier-dashboard/requirements", { headers: h })).json()).requirements.find(r => r.id === requirementId);
      expect(mine).toBeTruthy();
      expect(Object.keys(mine)).not.toEqual(expect.arrayContaining(["target_price"]));
      expect(Object.keys(mine)).not.toEqual(expect.arrayContaining(["delivery_city"]));
      expect(JSON.stringify(mine)).not.toMatch(/777|Pune|Secret Buyer|buyer_id|example\.com/i);
    }
    const q = await request.post(`/api/supplier-dashboard/requirements/${requirementId}/quote`, { headers: sh, data: { unitPrice: 12.5, currency: "USD", leadTime: "25 days" } });
    expect(q.status()).toBe(201);
    expect((await q.json()).message).toMatch(/SupplyDesk/);
    expect((await q.json()).message).not.toMatch(/buyer/i);

    // buyer: never sees a supplier quote, supplier name or label
    const bq = await (await request.get(`/api/buyer-requirements/${requirementId}/quotes`, { headers: bh })).json();
    expect(bq.quotes).toEqual([]);
    expect(JSON.stringify(bq)).not.toMatch(/Zenith|India Growth|supplier_label|12\.5/);
    const dash = JSON.stringify(await (await request.get("/api/buyer-dashboard", { headers: bh })).json());
    expect(dash).not.toMatch(/Zenith|India Growth|supplierId|supplierName/);
    // SupplyDesk (admin) can still see it internally
    const internal = await request.get(`/api/admin/requirements/${requirementId}/quotes`, { headers: ah });
    expect(internal.status()).toBe(200);
    expect(JSON.stringify(await internal.json())).toContain("12.5");
  });

  test("multi-supplier allocation, consolidation, capacity holds, supplier + buyer status tracking", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const su = await login(request, SID, SPW);
    const b1 = await placeOrder(request, ah, 40000, "m1");
    const b2 = await placeOrder(request, ah, 30000, "m2");
    for (const b of [b1, b2]) expect((await request.post(`/api/admin/orders/${b.orderId}/review`, { headers: ah, data: { decision: "accept" } })).status()).toBe(200);
    const sd = await (await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [b1.orderId, b2.orderId], title: "Core flow multi-supplier" } })).json();
    const poUrl = `/api/admin/sd-orders/${sd.sdOrderId}/supplier-pos`;

    // a product whose capacity is NOT verified can never be used for live procurement
    expect((await request.post("/api/supplier-dashboard/products", { headers: seedH, data: { product_name: "Unverified " + stamp, category: "Plastics & Polymers", subcategory: "Containers", monthly_capacity: 1000, available_capacity: 900, capacity_unit: "pcs", lead_time_days: 5 } })).status()).toBeLessThan(300);
    const un = (await (await request.get("/api/supplier-dashboard/products", { headers: seedH })).json()).products.find(p => p.product_name === "Unverified " + stamp);
    await request.patch(`/api/admin/products/${un.id}`, { headers: ah, data: { status: "approved" } });
    expect((await request.post(poUrl, { headers: ah, data: { capabilityCode: un.capability_code, unitCost: 5 } })).status()).toBe(404);

    // 40,000 to the Delhi supplier, 30,000 to the Haryana supplier, each tied to its exact buyer order
    const p1 = await request.post(poUrl, { headers: ah, data: { capabilityCode: seedCode, unitCost: 30, allocations: [{ buyerOrderId: b1.orderId, quantity: 40000 }] } });
    expect(p1.status()).toBe(201);
    const p2 = await request.post(poUrl, { headers: ah, data: { capabilityCode: newCode, unitCost: 32, allocations: [{ buyerOrderId: b2.orderId, quantity: 30000 }] } });
    expect(p2.status()).toBe(201);
    const po1 = await p1.json(), po2 = await p2.json();

    // INTERNAL view: total requirement split by region and supplier, reconciling to the total
    const al = await (await request.get(`/api/admin/sd-orders/${sd.sdOrderId}/allocation`, { headers: su })).json();
    expect([al.totalRequirement, al.allocated, al.unallocated]).toEqual([70000, 70000, 0]);
    const reg = Object.fromEntries(al.regions.map(r => [r.region, r]));
    expect(reg.Delhi.suppliers.map(s => [s.supplier, s.quantity])).toEqual([[expect.stringContaining("India Growth"), 40000]]);
    expect(reg.Haryana.suppliers.map(s => s.quantity)).toEqual([30000]);
    expect(reg.Haryana.suppliers[0].supplier).toContain("Zenith");
    expect(reg.Delhi.total + reg.Haryana.total).toBe(al.totalRequirement);
    // normal admins only get aliases
    const alAdmin = JSON.stringify(await (await request.get(`/api/admin/sd-orders/${sd.sdOrderId}/allocation`, { headers: ah })).json());
    expect(alAdmin).not.toMatch(/Zenith|India Growth/);
    expect(alAdmin).toMatch(/Supplier [0-9A-F]{6}/);
    // buyers and suppliers cannot open it
    expect((await request.get(`/api/admin/sd-orders/${sd.sdOrderId}/allocation`, { headers: sh })).status()).toBeGreaterThanOrEqual(401);
    expect((await request.get(`/api/admin/sd-orders/${sd.sdOrderId}/allocation`, { headers: b1.bh })).status()).toBeGreaterThanOrEqual(401);

    // permanent mapping for each buyer order
    const t1 = await (await request.get(`/api/admin/orders/${b1.orderId}/trace`, { headers: ah })).json();
    const t2 = await (await request.get(`/api/admin/orders/${b2.orderId}/trace`, { headers: ah })).json();
    expect(t1.supplierPos.map(p => p.po_number)).toEqual([po1.poNumber]);
    expect(t2.supplierPos.map(p => p.po_number)).toEqual([po2.poNumber]);

    // suppliers see ONLY a SupplyDesk PO, with the supplier-side status wording and no buyer data
    const m1 = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: seedH })).json()).purchaseOrders.find(p => p.id === po1.supplierPoId);
    const m2 = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).json()).purchaseOrders.find(p => p.id === po2.supplierPoId);
    expect([m1.statusLabel, m1.quantity, m2.quantity]).toEqual(["SupplyDesk PO", "40000", "30000"]);
    for (const m of [m1, m2]) expect(JSON.stringify(m)).not.toMatch(/Hidden Buyer|@example\.com|buyer|50\.0000/i);
    expect(JSON.stringify(m1)).not.toContain(b2.poNumber);

    // capacity: issued POs are ALLOCATED; the public number drops by exactly that (90,000-40,000) + (40,000-30,000)
    const cap = async () => (await (await request.get("/api/products")).json()).products.find(p => p.name === WIDGET).capacity.available;
    expect(await cap()).toBe(60000);
    const sup = (h, id, status, data = {}) => request.patch(`/api/supplier-dashboard/purchase-orders/${id}/status`, { headers: h, data: { status, ...data } });
    // Haryana accepts -> committed (still not free capacity); buyer 2 sees SupplyDesk milestones only
    expect((await sup(sh, po2.supplierPoId, "accepted")).status()).toBe(200);
    expect(await cap()).toBe(60000);
    const mine2 = (await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).json()).purchaseOrders.find(p => p.id === po2.supplierPoId);
    expect(mine2.statusLabel).toBe("Accepted");
    expect((await buyerOrder(request, b2)).stageLabel).toBe("Production Confirmed");
    expect((await sup(sh, po2.supplierPoId, "in_production")).status()).toBe(200);
    expect((await buyerOrder(request, b2)).stageLabel).toBe("Material in Production");
    expect((await sup(sh, po2.supplierPoId, "ready_for_qc")).status()).toBe(200);
    expect((await (await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).json()).purchaseOrders.find(p => p.id === po2.supplierPoId).statusLabel).toBe("QC");
    expect((await buyerOrder(request, b2)).stageLabel).toBe("Production Completed");
    const buyerJson = JSON.stringify(await buyerOrder(request, b2));
    expect(buyerJson).not.toMatch(/Zenith|India Growth|supplier_id|supplierId|SPO-/);

    // Delhi declines -> its 40,000 is released back to free capacity
    expect((await sup(seedH, po1.supplierPoId, "declined")).status()).toBe(400);   // reason required
    expect((await sup(seedH, po1.supplierPoId, "declined", { note: "Line down" })).status()).toBe(200);
    expect(await cap()).toBe(100000);                                              // 90,000 + 10,000 (Haryana's 30,000 stays committed)
    const seedApp = await (await request.get("/api/admin/applications/00000000-0000-4000-8000-000000000001", { headers: ah })).json();
    const seedWidget = seedApp.onboarding.products.find(p => p.id === seedProductId);
    expect([Number(seedWidget.allocated_capacity), Number(seedWidget.committed_capacity)]).toEqual([0, 0]);
    const newApp = await (await request.get(`/api/admin/applications/${(await (await request.get("/api/admin/applications", { headers: ah })).json()).applications.find(a => a.business_email === EMAIL).id}`, { headers: ah })).json();
    const mineW = newApp.onboarding.products.find(p => p.id === newProductId);
    expect([Number(mineW.allocated_capacity), Number(mineW.committed_capacity)]).toEqual([0, 30000]);
  });

  test("rejecting or suspending a supplier removes it from procurement, matching and public capacity", async ({ request }) => {
    const ah = await login(request, AID, APW);
    const move = (status, extra = {}) => request.patch(`/api/admin/suppliers/${pid}/onboarding`, { headers: ah, data: { status, ...extra } });
    expect((await move("rejected")).status()).toBe(400);
    const r = await move("needs_resubmission", { note: "Please re-upload a clearer registration certificate" });
    expect(r.status()).toBe(200);
    expect((await r.json()).eligible).toBe(false);
    // dashboard login still works so the supplier can fix and resubmit, but no live orders
    expect((await request.get("/api/supplier-dashboard/purchase-orders", { headers: sh })).status()).toBe(403);
    expect((await request.get("/api/supplier-dashboard/requirements", { headers: sh })).status()).toBe(403);
    const o = await (await request.get("/api/supplier-dashboard/onboarding", { headers: sh })).json();
    expect([o.status, o.note, o.eligible, o.canSubmit]).toEqual(["needs_resubmission", "Please re-upload a clearer registration certificate", false, true]);
    // public capacity no longer includes this supplier; no PO can be issued to it
    const card = (await (await request.get("/api/products")).json()).products.find(p => p.name === WIDGET);
    expect(card.capacity.available).toBe(null);                                     // back to a single supplier -> band only
    const b = await placeOrder(request, ah, 100, "rj");
    await request.post(`/api/admin/orders/${b.orderId}/review`, { headers: ah, data: { decision: "accept" } });
    const sd = await (await request.post("/api/admin/sd-orders", { headers: ah, data: { buyerOrderIds: [b.orderId] } })).json();
    expect((await request.post(`/api/admin/sd-orders/${sd.sdOrderId}/supplier-pos`, { headers: ah, data: { capabilityCode: newCode, unitCost: 1 } })).status()).toBe(404);
    // resubmit -> pending; final reject
    expect((await request.post("/api/supplier-dashboard/onboarding/submit", { headers: sh })).status()).toBe(200);
    expect((await move("rejected", { note: "Not a fit" })).status()).toBe(200);
    expect((await move("supplydesk_approved", { agreementSigned: true })).status()).toBe(409);   // rejected -> approved is not allowed directly
    const final = await (await request.get("/api/supplier-dashboard/onboarding", { headers: sh })).json();
    expect(final.status).toBe("rejected");
  });
});

test.describe("legacy data safety", () => {
  test.skip(!KEY, "needs E2E_TEST_KEY");
  test("existing approved supplier keeps logging in, stays eligible and keeps its data", async ({ request }) => {
    const r = await (await request.post("/api/supplier-dashboard/request-otp", { headers: { "x-e2e-key": KEY }, data: { email: "supplier-e2e@example.com" } })).json();
    const v = await (await request.post("/api/supplier-dashboard/verify-otp", { data: { email: "supplier-e2e@example.com", otp: r.testOtp } })).json();
    const h = { "x-supplier-dashboard-token": v.token };
    const d = await (await request.get("/api/supplier-dashboard", { headers: h })).json();
    expect(d.supplier.eligible).toBe(true);
    expect(d.products.some(p => p.product_name === "E2E Test Product")).toBe(true);
    expect((await request.get("/api/supplier-dashboard/purchase-orders", { headers: h })).status()).toBe(200);
  });
  test("login for an unknown email is still refused", async ({ request }) => {
    const res = await request.post("/api/supplier-dashboard/request-otp", { headers: { "x-e2e-key": KEY }, data: { email: `nobody-${Date.now()}@example.com` } });
    expect(res.status()).toBe(404);
  });
});
