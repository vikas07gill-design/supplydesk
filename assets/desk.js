/* SupplyDesk shared helpers. Loaded on every public page (external file, so it
   runs under the default Helmet content-security-policy). */
(function () {
  "use strict";

  var FALLBACK_CATALOG = {
    "Raw Materials": ["Metals", "Minerals", "Polymers", "Industrial Raw Materials"],
    "Plastics & Packaging": ["Plastic Containers", "Plastic Bottles", "Packaging Films", "Plastic Components"],
    "Machinery": ["Injection Moulding Machines", "CNC Machines", "Packaging Machines", "Industrial Machinery"],
    "Electronics & Components": ["Electronic Components", "PCB", "Power Supplies", "Sensors"],
    "Automotive": ["Auto Components", "Accessories", "Aftermarket Parts"],
    "Textiles & Apparel": ["Fabrics", "Garments", "Home Textiles"],
    "Food & Agriculture": ["Food Ingredients", "Agri Products", "Processed Food"],
    "Chemicals": ["Industrial Chemicals", "Specialty Chemicals", "Cleaning Chemicals"],
    "Consumer Products": ["Household Products", "Kitchenware", "Personal Care"],
    "Construction Materials": ["Building Materials", "Tiles & Surfaces", "Plumbing Products"],
    "Logistics & Freight": ["Sea Freight", "Air Freight", "Road Transport", "Freight Forwarding"],
    "Warehousing & Fulfilment": ["Warehousing", "Consolidation", "Fulfilment"],
    "Customs & Trade": ["Customs Clearance", "Trade Documentation", "Import Export Support"],
    "Inspection & Verification": ["Factory Inspection", "Pre-shipment Inspection", "Quality Inspection"],
    "Insurance": ["Cargo Insurance", "Transit Insurance", "Trade Insurance"],
    "Trade Finance": ["Trade Finance", "Letter of Credit", "Working Capital"],
    "Sourcing Services": ["Product Sourcing", "Supplier Discovery", "Procurement Support"],
    "Professional Services": ["Consulting", "Accounting & Tax", "Legal Services"],
    "Industrial Equipment": ["Process Equipment", "Material Handling", "Plant Equipment"],
    "Electrical Equipment": ["Electrical Components", "Switchgear", "Industrial Controls"],
    "Tools & Hardware": ["Hand Tools", "Power Tools", "Hardware"],
    "Metal Products": ["Steel Products", "Aluminium Products", "Fabricated Parts"],
    "Industrial Components": ["Bearings", "Fasteners", "Seals"],
    "Manufacturing Services": ["Contract Manufacturing", "Assembly", "Fabrication"]
  };

  var GROUPS = {
    Products: ["Raw Materials", "Plastics & Packaging", "Machinery", "Electronics & Components", "Automotive", "Textiles & Apparel", "Food & Agriculture", "Chemicals", "Consumer Products", "Construction Materials"],
    Services: ["Logistics & Freight", "Warehousing & Fulfilment", "Customs & Trade", "Inspection & Verification", "Insurance", "Trade Finance", "Sourcing Services", "Professional Services"],
    Industrial: ["Industrial Equipment", "Electrical Equipment", "Tools & Hardware", "Metal Products", "Industrial Components", "Manufacturing Services"]
  };

  var SERVICE_CATEGORIES = GROUPS.Services.concat(["Manufacturing Services"]);
  var TOKEN_KEY = "supplydesk_buyer_dashboard_token";
  var catalogPromise = null;

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function $(id) { return document.getElementById(id); }

  function buyerToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  function setBuyerToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
  }
  function clearBuyerToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  /* fetch JSON without throwing: { ok, status, data } */
  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }

  /* categories from the server, falling back to the built-in list */
  function catalog() {
    if (!catalogPromise) {
      catalogPromise = fetch("/api/categories")
        .then(function (r) { if (!r.ok) throw new Error("x"); return r.json(); })
        .then(function (d) {
          var subs = d.subcategories || d.catalog || {};
          var cats = d.categories && d.categories.length ? d.categories : Object.keys(subs);
          if (!cats.length) throw new Error("empty");
          return { categories: cats, subs: subs };
        })
        .catch(function () {
          return { categories: Object.keys(FALLBACK_CATALOG), subs: FALLBACK_CATALOG };
        });
    }
    return catalogPromise;
  }

  /* animate a number up to a target */
  function count(el, target) {
    var t = Number(target) || 0, n = 0;
    if (!el) return;
    if (!t || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = t; return; }
    var step = Math.max(1, Math.ceil(t / 25));
    var id = setInterval(function () {
      n = Math.min(t, n + step);
      el.textContent = n;
      if (n >= t) clearInterval(id);
    }, 35);
  }

  /* drag a card around with a mouse. A click still follows the link unless the
     card was actually moved. Touch devices keep normal scrolling. */
  var zTop = 10;
  function drag(el) {
    var sx, sy, ox = 0, oy = 0, moved = false, active = false;
    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse" || e.button) return;
      sx = e.clientX; sy = e.clientY;
      ox = parseFloat(el.dataset.tx || 0); oy = parseFloat(el.dataset.ty || 0);
      moved = false; active = true;
      el.style.zIndex = ++zTop;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", function (e) {
      if (!active) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      if (moved) {
        el.dataset.tx = ox + dx; el.dataset.ty = oy + dy;
        el.style.transform = "translate(" + (ox + dx) + "px," + (oy + dy) + "px) rotate(0deg)";
        el.style.cursor = "grabbing";
      }
    });
    function up() { active = false; el.style.cursor = ""; }
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", function (e) { if (moved) { e.preventDefault(); moved = false; } });
    el.addEventListener("dragstart", function (e) { e.preventDefault(); });
  }

  /* mark the current page in the header and close the mobile menu on navigation */
  function initChrome() {
    var here = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");
    var q = new URLSearchParams(location.search);
    document.querySelectorAll(".links a").forEach(function (a) {
      var u = new URL(a.getAttribute("href"), location.href);
      var page = (u.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");
      var same = page === here;
      if (same && page === "search") same = (u.searchParams.get("type") || "") === (q.get("type") || "");
      if (same) a.setAttribute("aria-current", "page");
    });
    var menu = document.querySelector(".menu");
    if (menu) {
      menu.addEventListener("click", function (e) { if (e.target.closest(".drop a")) menu.removeAttribute("open"); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") menu.removeAttribute("open"); });
    }
  }

  window.SD = {
    esc: esc, $: $, api: api, catalog: catalog, count: count, drag: drag,
    buyerToken: buyerToken, setBuyerToken: setBuyerToken, clearBuyerToken: clearBuyerToken,
    GROUPS: GROUPS, SERVICE_CATEGORIES: SERVICE_CATEGORIES, FALLBACK_CATALOG: FALLBACK_CATALOG
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initChrome);
  else initChrome();
})();
