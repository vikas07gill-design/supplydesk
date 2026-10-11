// Test helper: collect the buyer's advance so a PO can be released.
async function payAdvance(request, headers, orderId) {
  const inv = await request.post(`/api/admin/orders/${orderId}/invoice`, { headers, data: { kind: "advance" } });
  if (inv.status() !== 201) throw new Error("advance invoice failed: " + inv.status() + " " + await inv.text());
  const j = await inv.json();
  const pay = await request.post(`/api/admin/invoices/${j.invoiceId}/payments`, { headers, data: { amount: j.total ?? j.totalAmount, method: "bank_transfer", reference: "ADV-" + orderId.slice(0, 6) } });
  if (pay.status() >= 300) throw new Error("advance payment failed: " + pay.status() + " " + await pay.text());
  return j;
}
module.exports = { payAdvance };
