// Test helper: collect the buyer's advance so a PO can be released.
async function payAdvance(request, headers, orderId) {
  const inv = await request.post(`/api/admin/orders/${orderId}/invoice`, { headers, data: { kind: "advance" } });
  if (inv.status() !== 201) throw new Error("advance invoice failed: " + inv.status() + " " + await inv.text());
  const j = await inv.json();
  const pay = await request.post(`/api/admin/invoices/${j.invoiceId}/payments`, { headers, data: { amount: j.total ?? j.totalAmount, method: "bank_transfer", reference: "ADV-" + orderId.slice(0, 6) } });
  if (pay.status() >= 300) throw new Error("advance payment failed: " + pay.status() + " " + await pay.text());
  return j;
}
// Supplier sends an invoice (billed to SupplyDesk) against a PO; SupplyDesk accepts it.
async function supplierInvoice(request, sh, poId, taxable, extra = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await request.post(`/api/supplier-dashboard/purchase-orders/${poId}/invoice`, { headers: sh, multipart: {
    invoiceNo: "SI-" + poId.slice(0, 6) + "-" + Math.floor(Math.random() * 1e6), invoiceDate: today, taxable: String(taxable), gst: "0", billedToSupplyDesk: "true",
    invoice: { name: "inv.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") }, ...extra } });
  return r;
}
async function sendAndAcceptInvoice(request, sh, adminHeaders, poId, taxable) {
  const r = await supplierInvoice(request, sh, poId, taxable);
  if (r.status() !== 201) throw new Error("supplier invoice failed: " + r.status() + " " + await r.text());
  const list = (await (await request.get(`/api/supplier-dashboard/purchase-orders/${poId}/invoice`, { headers: sh })).json()).invoices;
  const acc = await request.post(`/api/admin/supplier-invoices/${list[0].id}/accept`, { headers: adminHeaders, data: {} });
  if (acc.status() !== 200) throw new Error("accept failed: " + acc.status() + " " + await acc.text());
  return list[0];
}
module.exports = { payAdvance, supplierInvoice, sendAndAcceptInvoice };
