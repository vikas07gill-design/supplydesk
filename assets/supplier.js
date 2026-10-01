/* Supplier profile page. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var params = new URLSearchParams(location.search);
  var id = params.get("id") || "";
  var requestedProduct = params.get("product") || "";
  var supplier = null;

  function renderProfile(p) {
    supplier = p;
    document.title = p.name + " | SupplyDesk";
    $("name").textContent = p.name;
    $("avatar").textContent = p.name.charAt(0).toUpperCase();
    $("meta").textContent = [p.city, p.type].filter(Boolean).join(" · ");
    $("badges").innerHTML = '<span class="badge ok">✓ SupplyDesk verified</span><span class="badge">Direct connection</span>';

    var d = p.profileDetails || {};
    $("about").textContent = d.about || p.about || ("Listed " + (p.type || "business") + " on SupplyDesk.");
    $("products").innerHTML = (p.products || []).map(function (x) {
      return '<div class="mini"><b>' + esc(x) + "</b><small>SupplyDesk listing</small></div>";
    }).join("");

    var facts = [
      ["Industries", d.industries], ["Markets", d.markets], ["Monthly capacity", d.monthlyCapacity],
      ["Lead time", d.leadTime], ["Payment terms", d.paymentTerms], ["Incoterms", d.incoterms],
      ["Shipping", d.shippingModes], ["Certifications", d.certifications], ["OEM", d.oem],
      ["Custom manufacturing", d.customManufacturing]
    ].filter(function (x) { return x[1]; });
    if (d.about || d.capabilities || facts.length) {
      $("profileAbout").innerHTML = d.capabilities ? "<p>" + esc(d.capabilities) + "</p>" : "";
      $("profileFacts").innerHTML = facts.map(function (x) { return '<span class="badge">' + esc(x[0]) + ": " + esc(x[1]) + "</span>"; }).join("");
      $("profileBox").hidden = false;
    }
    $("connectBtn").disabled = false;
  }

  function open(action) {
    if (!supplier) return;
    SDEnquiry.open({
      supplierId: supplier.id || id,
      productName: requestedProduct,
      title: "Connect with " + supplier.name,
      intro: "Enter your details. SupplyDesk emails the supplier that you want to connect. Their direct contact details stay private.",
      action: action
    });
  }
  $("phoneBtn").addEventListener("click", function () { open("phone"); });
  $("mailBtn").addEventListener("click", function () { open("email"); });
  $("connectBtn").addEventListener("click", function () { open("contact"); });

  function notFound(text) {
    $("name").textContent = "Supplier not found";
    $("meta").textContent = text || "This supplier is not currently published.";
    $("avatar").textContent = "?";
    $("about").textContent = "Open a supplier from SupplyDesk search.";
    $("connectBtn").disabled = true;
    $("contact").hidden = true;
  }

  if (!id) { notFound("Open a supplier from SupplyDesk search."); return; }

  SD.api("/api/suppliers/" + encodeURIComponent(id)).then(function (r) {
    var p = r.data && r.data.supplier;
    if (!r.ok || !p) { notFound(); return; }
    var name = p.trade_name || p.legal_name;
    renderProfile({
      id: p.id, name: name,
      city: [p.city, p.country].filter(Boolean).join(", "),
      type: p.business_type,
      about: (p.legal_name || name) + " · " + p.business_type + " listed on SupplyDesk.",
      products: [p.category + " · " + p.subcategory],
      profileDetails: p.profileDetails || {}
    });
    SD.api("/api/suppliers/" + encodeURIComponent(id) + "/view", { method: "POST" });
    return SD.api("/api/suppliers/" + encodeURIComponent(id) + "/products").then(function (pr) {
      var items = (pr.data && pr.data.products) || [];
      if (!items.length) return;
      $("liveProducts").innerHTML = items.map(function (x) {
        return '<a class="mini" href="product.html?id=' + encodeURIComponent(x.id) + '"><b>' + esc(x.product_name) + "</b><small>" + esc(x.category) + " · " + esc(x.subcategory) + "</small></a>";
      }).join("");
      $("liveBox").hidden = false;
    });
  }).catch(function () { notFound("We could not load this supplier right now."); });
})();
