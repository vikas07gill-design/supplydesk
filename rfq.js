// RFQ domain rules for SupplyDesk (pure functions, no database access).
// One explicit state machine for the buyer requirement; never a pile of booleans.

const STATES = {
  submitted:       { label: "Submitted",                 buyerLabel: "Received by SupplyDesk" },
  matching:        { label: "Matching capacity",         buyerLabel: "SupplyDesk is checking capacity" },
  sourcing:        { label: "Sourcing from suppliers",   buyerLabel: "SupplyDesk is sourcing" },
  quotes_received: { label: "Supplier quotes received",  buyerLabel: "SupplyDesk is reviewing quotes" },
  costing:         { label: "Costing / SupplyDesk quote", buyerLabel: "SupplyDesk is preparing your quote" },
  quote_sent:      { label: "Quote sent to buyer",       buyerLabel: "Quote ready" },
  buyer_approved:  { label: "Buyer approved",            buyerLabel: "Approved by you" },
  converted:       { label: "Converted to order",        buyerLabel: "Order created" },
  lost:            { label: "Lost",                      buyerLabel: "Closed" },
  rejected:        { label: "Rejected",                  buyerLabel: "Not accepted" },
  closed:          { label: "Closed",                    buyerLabel: "Closed" },
  cancelled:       { label: "Cancelled",                 buyerLabel: "Cancelled" }
};

const TRANSITIONS = {
  submitted:       ["matching", "sourcing", "costing", "rejected", "cancelled"],
  matching:        ["sourcing", "costing", "rejected", "cancelled"],
  sourcing:        ["quotes_received", "costing", "closed", "cancelled"],
  quotes_received: ["costing", "closed", "cancelled"],
  costing:         ["sourcing", "quote_sent", "closed", "cancelled"],
  quote_sent:      ["buyer_approved", "lost", "costing", "cancelled"],
  buyer_approved:  ["converted", "cancelled"],
  converted: [], lost: [], rejected: [], closed: [], cancelled: []
};

const LEGACY_STATUS_TO_STATE = {
  pending_review: "submitted", open: "sourcing", fulfilling: "costing",
  rejected: "rejected", closed: "closed", cancelled: "cancelled"
};

const isState = (s) => Object.prototype.hasOwnProperty.call(STATES, s);
const canTransition = (from, to) => from === to || (TRANSITIONS[from] || []).includes(to);
const isTerminal = (s) => isState(s) && TRANSITIONS[s].length === 0;

// First whole number found in free text such as "5,000 pcs / monthly" or "10k pcs".
function parseQuantity(text) {
  const m = String(text == null ? "" : text).toLowerCase().replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k|m|lakh|lac|crore)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const mult = { k: 1e3, m: 1e6, lakh: 1e5, lac: 1e5, crore: 1e7 }[m[2]] || 1;
  n = Math.round(n * mult);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const STOP = new Set(["the","a","an","and","or","for","of","to","in","with","need","needs","want","looking","require","required","supplier","manufacturer","pcs","piece","pieces","qty","quantity","monthly","per","month"]);
function words(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}

// Rank approved product capabilities for one requirement. Returns reasons so admin can see why.
function scoreCapability(rfq, cap, now = Date.now()) {
  const reasons = []; let score = 0;
  if (rfq.subcategory && cap.subcategory === rfq.subcategory) { score += 40; reasons.push("Same sub-category"); }
  else if (rfq.category && cap.category === rfq.category) { score += 25; reasons.push("Same category"); }
  else if (rfq.category || rfq.subcategory) return { score: 0, reasons: ["Different category"], eligible: false };

  const want = new Set(words([rfq.title, rfq.specification].join(" ")));
  const have = new Set(words([cap.product_name, cap.description].join(" ")));
  let hits = 0; for (const w of want) if (have.has(w)) hits++;
  if (hits) { score += Math.min(20, hits * 5); reasons.push(hits + " keyword match" + (hits > 1 ? "es" : "")); }

  const qty = parseQuantity(rfq.quantity);
  const available = cap.available_capacity == null ? null : Number(cap.available_capacity);
  const updated = cap.capacity_updated_at ? new Date(cap.capacity_updated_at).getTime() : null;
  const stale = !updated || now - updated > 45 * 86400000;
  if (available == null) { reasons.push("Capacity not provided"); }
  else if (available <= 0) { score -= 10; reasons.push("Fully booked"); }
  else if (qty == null) { score += 5; reasons.push("Available now: " + available.toLocaleString("en-US")); }
  else if (available >= qty) { score += 20; reasons.push("Covers full quantity (" + available.toLocaleString("en-US") + " available)"); }
  else { score += 8; reasons.push("Partial only: " + available.toLocaleString("en-US") + " of " + qty.toLocaleString("en-US")); }
  if (available != null && stale) { score -= 5; reasons.push("Capacity not updated for 45+ days"); }

  if (rfq.required_by && cap.lead_time_days != null) {
    const days = Math.floor((new Date(rfq.required_by).getTime() - now) / 86400000);
    if (cap.lead_time_days <= days) { score += 10; reasons.push("Lead time " + cap.lead_time_days + "d fits (" + days + "d left)"); }
    else { score -= 5; reasons.push("Lead time " + cap.lead_time_days + "d exceeds the " + Math.max(days, 0) + " days left"); }
  }
  if (rfq.delivery_country && cap.country && rfq.delivery_country.toLowerCase() === String(cap.country).toLowerCase()) { score += 5; reasons.push("Same country as delivery"); }
  return { score, reasons, eligible: true, coversFull: qty != null && available != null && available >= qty, stale };
}

function newRfqCode(now = new Date()) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const crypto = require("crypto");
  let tail = ""; for (let i = 0; i < 4; i++) tail += alphabet[crypto.randomInt(alphabet.length)];
  return "RFQ-" + now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + tail;
}


// ---- Orders (Phase 2) ----
const ORDER_STATES = {
  confirmed:     { label: "Confirmed",     buyerLabel: "Order confirmed" },
  in_production: { label: "In production", buyerLabel: "Being produced" },
  shipped:       { label: "Shipped",       buyerLabel: "Shipped" },
  delivered:     { label: "Delivered",     buyerLabel: "Delivered" },
  cancelled:     { label: "Cancelled",     buyerLabel: "Cancelled" }
};
const ORDER_TRANSITIONS = {
  confirmed: ["in_production", "cancelled"],
  in_production: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [], cancelled: []
};
const isOrderState = (s) => Object.prototype.hasOwnProperty.call(ORDER_STATES, s);
const canOrderTransition = (from, to) => from === to || (ORDER_TRANSITIONS[from] || []).includes(to);
const _code = (prefix) => {
  const d = new Date(), a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let x = ""; for (let i = 0; i < 4; i++) x += a[Math.floor(Math.random() * a.length)];
  return `${prefix}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}-${x}`;
};
const newQuoteNo = () => _code("SQ");
const newPoNumber = () => _code("PO");


// ---- Supplier purchase orders (Phase 3) ----
const PO_STATES = {
  issued:             { label: "Issued" },
  accepted:           { label: "Accepted by supplier" },
  partially_accepted: { label: "Partially accepted by supplier" },
  declined:           { label: "Rejected by supplier" },
  in_production:      { label: "Production started" },
  ready_for_qc:       { label: "Ready for QC" },
  ready_for_dispatch: { label: "Ready for dispatch" },
  dispatched:         { label: "Dispatched" },
  completed:          { label: "Completed" },
  cancelled:          { label: "Cancelled" }
};
const PO_TRANSITIONS = {
  issued: ["accepted", "partially_accepted", "declined", "cancelled"],
  accepted: ["in_production", "cancelled"],
  partially_accepted: ["in_production", "cancelled"],
  in_production: ["ready_for_qc", "dispatched", "cancelled"],
  ready_for_qc: ["ready_for_dispatch", "cancelled"],
  ready_for_dispatch: ["dispatched", "cancelled"],
  dispatched: ["completed"],
  completed: [], declined: [], cancelled: []
};
const isPoState = (s) => Object.prototype.hasOwnProperty.call(PO_STATES, s);
const canPoTransition = (from, to) => from === to || (PO_TRANSITIONS[from] || []).includes(to);
const newSupplierPoNumber = () => _code("SPO");


// ---- Order architecture: Buyer PO -> SupplyDesk order (SD) -> Supplier PO ----
// 1. Every buyer order first goes through SupplyDesk review.
const ORDER_REVIEW = {
  pending_review:        { label: "Pending Review",        buyerLabel: "Order received. SupplyDesk is reviewing it" },
  accepted:              { label: "Accepted",              buyerLabel: "Accepted by SupplyDesk" },
  partially_accepted:    { label: "Partially Accepted",    buyerLabel: "Partially accepted by SupplyDesk" },
  pending_clarification: { label: "Pending Clarification", buyerLabel: "SupplyDesk needs a clarification from you" },
  rejected:              { label: "Rejected",              buyerLabel: "Not accepted by SupplyDesk" }
};
const isReviewState = (s) => Object.prototype.hasOwnProperty.call(ORDER_REVIEW, s);
const REVIEW_DECISIONS = { accept: "accepted", partial: "partially_accepted", clarify: "pending_clarification", reject: "rejected" };
const reviewOpen = (s) => s === "pending_review" || s === "pending_clarification";   // states in which SupplyDesk may still decide
const reviewAccepted = (s) => s === "accepted" || s === "partially_accepted";        // states in which the order may be fulfilled

// 2. The buyer-facing timeline. Buyers only ever see these labels, never a supplier.
const STAGES = [
  { key: "order_received",       label: "Order Received" },
  { key: "supplydesk_accepted",  label: "SupplyDesk Accepted" },
  { key: "production_confirmed", label: "Production Confirmed",  supplier: true },   // needs supplier acknowledgement
  { key: "in_production",        label: "Material in Production", supplier: true },
  { key: "production_completed", label: "Production Completed",  supplier: true },
  { key: "qc_completed",         label: "QC Completed" },
  { key: "ready_for_transport",  label: "Ready for Transport" },
  { key: "transport_booked",     label: "Transport Booked" },
  { key: "insurance_completed",  label: "Insurance Completed" },
  { key: "in_transit",           label: "In Transit" },
  { key: "out_for_delivery",     label: "Out for Delivery" },
  { key: "delivered",            label: "Delivered" },
  { key: "order_closed",         label: "Order Closed" }
];
const STAGE_KEYS = STAGES.map(s => s.key);
const stageIndex = (k) => STAGE_KEYS.indexOf(k);
const stageLabel = (k) => (STAGES[stageIndex(k)] || {}).label || k;
const isStage = (k) => stageIndex(k) >= 0;
// The older coarse order status is kept (invoices, margin, reports) and derived from the stage.
function legacyStatusForStage(k) {
  const i = stageIndex(k);
  if (i >= stageIndex("delivered")) return "delivered";
  if (i >= stageIndex("in_transit")) return "shipped";
  if (i >= stageIndex("in_production")) return "in_production";
  return "confirmed";
}
// Supplier progress -> how far the buyer timeline may move on its own. Lowest live PO wins.
const PO_RANK = { issued: 0, accepted: 1, partially_accepted: 1, in_production: 2, ready_for_qc: 3, ready_for_dispatch: 4, dispatched: 4, completed: 4 };
function autoStageFromPos(statuses) {
  if (!statuses.length) return null;
  const min = Math.min(...statuses.map(s => PO_RANK[s] == null ? 0 : PO_RANK[s]));
  return min >= 3 ? "production_completed" : min === 2 ? "in_production" : min === 1 ? "production_confirmed" : null;
}
const poReadyForDispatch = (statuses) => statuses.length > 0 && statuses.every(s => (PO_RANK[s] || 0) >= 4);
// SupplyDesk-driven steps: strictly the next stage, and never one that waits for supplier confirmation.
function manualStageProblem(current, to, posStatuses) {
  const ci = stageIndex(current), ti = stageIndex(to);
  if (ti < 0) return "Unknown stage.";
  if (STAGES[ti].supplier || to === "supplydesk_accepted" || to === "order_received") return "\"" + stageLabel(to) + "\" is set automatically (after the supplier confirms), not by hand.";
  if (ti !== ci + 1) return "The next step is \"" + stageLabel(STAGE_KEYS[Math.min(ci + 1, STAGE_KEYS.length - 1)]) + "\".";
  if (to === "qc_completed" && current !== "production_completed") return "QC can be completed only after production is completed.";
  if (to === "ready_for_transport" && !poReadyForDispatch(posStatuses)) return "The supplier has not yet marked the goods ready for dispatch.";
  return null;
}
const newSdNumber = () => _code("SD");


// ---- Invoices & payments (Phase 5). Money is handled in integer minor units (paise/cents) to avoid float drift. ----
const toMinor = (v) => Math.round(Number(v) * 100);
const fromMinor = (n) => Math.round(n) / 100;
// subtotal + GST % -> { subtotal, gst, total } (all in major units, 2 dp)
function computeInvoice(subtotal, gstRate) {
  const sub = toMinor(subtotal), rate = Number(gstRate) || 0;
  if (!Number.isFinite(sub) || sub <= 0) return null;
  if (!Number.isFinite(rate) || rate < 0 || rate > 28) return null;
  const gst = Math.round(sub * rate / 100);
  return { subtotal: fromMinor(sub), gst: fromMinor(gst), total: fromMinor(sub + gst) };
}
const invoiceStatus = (total, paid) => {
  const t = toMinor(total), p = toMinor(paid);
  return p <= 0 ? "issued" : p >= t ? "paid" : "partially_paid";
};
const PAYMENT_METHODS = ["bank_transfer", "upi", "cheque", "cash", "other"];
const newInvoiceNo = () => _code("INV");


// ---- Margin. Margin is on the SELLING PRICE: price = cost / (1 - margin%). (priceFromMarkup kept for legacy callers.) ----
function priceFromMargin(cost, marginPct) {
  const c = Number(cost), m = Number(marginPct);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(m) || m < 0 || m > 90) return null;
  return Math.round(c / (1 - m / 100) * 10000) / 10000;
}
function priceFromMarkup(cost, markupPct) {
  const c = Number(cost), m = Number(markupPct);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(m) || m < 0 || m > 300) return null;
  return Math.round(c * (1 + m / 100) * 10000) / 10000;
}
function marginOf(price, cost) {
  const p = Number(price), c = Number(cost);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0 || c <= 0) return null;
  const amount = Math.round((p - c) * 10000) / 10000;
  return { amount, pctOnCost: Math.round((p - c) / c * 10000) / 100, pctOnPrice: Math.round((p - c) / p * 10000) / 100 };
}

// Buyer-facing progress: 1 Received, 2 In review/sourcing, 3 Quote ready, 4 Order
function buyerStep(state){
  if(["submitted","matching"].includes(state))return 1;
  if(["sourcing","quotes_received","costing"].includes(state))return 2;
  if(state==="quote_sent")return 3;
  if(["buyer_approved","converted"].includes(state))return 4;
  return 0;
}
module.exports = { STATES, TRANSITIONS, LEGACY_STATUS_TO_STATE, isState, canTransition, isTerminal, parseQuantity, scoreCapability, newRfqCode, ORDER_STATES, ORDER_TRANSITIONS, isOrderState, canOrderTransition, newQuoteNo, newPoNumber, PO_STATES, PO_TRANSITIONS, isPoState, canPoTransition, newSupplierPoNumber, toMinor, fromMinor, computeInvoice, invoiceStatus, PAYMENT_METHODS, newInvoiceNo, priceFromMarkup, priceFromMargin, marginOf, buyerStep,
  ORDER_REVIEW, isReviewState, REVIEW_DECISIONS, reviewOpen, reviewAccepted, STAGES, STAGE_KEYS, stageIndex, stageLabel, isStage, legacyStatusForStage, autoStageFromPos, poReadyForDispatch, manualStageProblem, newSdNumber, PO_RANK };
