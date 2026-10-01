/* Product page: loads one approved product and opens the enquiry pop-up. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var id = new URLSearchParams(location.search).get("id") || "";
  var product = null;

  function message(title, meta, desc) {
    $("name").textContent = title;
    $("meta").textContent = meta || "";
    $("desc").textContent = desc || "";
    $("crumb").textContent = "listing unavailable";
  }

  function showImage(url, name) {
    $("mainPic").innerHTML = '<img src="' + esc(url) + '" alt="' + esc(name) + '">';
    document.querySelectorAll("#thumbs button").forEach(function (b) {
      b.setAttribute("aria-current", String(b.dataset.url === url));
    });
  }

  function fact(label, value) {
    return value ? '<div class="fact"><small>' + esc(label) + "</small><b>" + esc(value) + "</b></div>" : "";
  }

  function load() {
    if (!id) { message("Product not found", "Open a product from SupplyDesk search.", "This page needs a published SupplyDesk product."); return; }
    SD.api("/api/products/" + encodeURIComponent(id)).then(function (r) {
      if (r.status === 404 || !r.data.product) {
        message("Product not found", "This product is not currently published.", "It may still be under review, or it may have been removed.");
        return;
      }
      if (!r.ok) throw new Error("load");
      var p = product = r.data.product;
      document.title = p.name + " | SupplyDesk";
      $("crumb").textContent = "product listing";
      $("name").textContent = p.name;
      $("meta").textContent = [p.city, p.country].filter(Boolean).join(", ") + (p.market_scope ? " · " + p.market_scope : "");
      $("desc").textContent = p.description || (p.category + " · " + p.subcategory);
      $("tags").innerHTML = [p.category, p.subcategory, p.market_scope].filter(Boolean).map(function (x) {
        return '<span class="tag">' + esc(x) + "</span>";
      }).join("");
      $("facts").innerHTML =
        fact("Minimum order", p.moq ? p.moq + (p.unit ? " " + p.unit : "") : "") +
        fact("Category", p.category) +
        fact("Sub-category", p.subcategory) +
        fact("Supplier", p.supplierName + (p.supplierType ? " (" + p.supplierType + ")" : "")) +
        fact("Location", [p.city, p.country].filter(Boolean).join(", ")) +
        fact("Market", p.market_scope);

      var imgs = p.images || [];
      if (imgs.length) {
        showImage(imgs[0].url, p.name);
        if (imgs.length > 1) {
          $("thumbs").innerHTML = imgs.map(function (i) {
            return '<button type="button" data-url="' + esc(i.url) + '" aria-label="Show photo"><img src="' + esc(i.url) + '" alt=""></button>';
          }).join("");
          $("thumbs").addEventListener("click", function (e) {
            var b = e.target.closest("button");
            if (b) showImage(b.dataset.url, p.name);
          });
          showImage(imgs[0].url, p.name);
        }
      } else {
        $("mainPic").textContent = (p.name || "?").charAt(0).toUpperCase();
      }

      var s = $("supplier");
      s.href = "supplier.html?id=" + encodeURIComponent(p.supplierId) + "&product=" + encodeURIComponent(p.name);
      s.hidden = false;
      $("connectBtn").hidden = false;
    }).catch(function () {
      message("Product unavailable", "", "We could not load this product right now. Please try again in a moment.");
    });
  }

  $("connectBtn").addEventListener("click", function () {
    if (!product) return;
    SDEnquiry.open({
      supplierId: product.supplierId,
      productId: product.id,
      productName: product.name,
      title: "Enquire about " + product.name,
      intro: "Your enquiry goes to " + (product.supplierName || "the supplier") + " through SupplyDesk. Their direct contact details stay private.",
      action: "contact"
    });
  });

  load();
})();
