/* Home page: request slip, live pinboard, category folders. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var type = "product";
  var q = $("q"), from = $("from");

  /* request slip */
  document.querySelectorAll(".seg button").forEach(function (b) {
    b.addEventListener("click", function () {
      type = b.dataset.t;
      document.querySelectorAll(".seg button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    });
  });

  function go(value) {
    value = (value || "").trim();
    if (!value) { q.focus(); return; }
    var p = new URLSearchParams({ q: value });
    if (type !== "product") p.set("type", type);
    if (from.value) p.set("from", from.value);
    location.href = "search.html?" + p.toString();
  }
  $("slip").addEventListener("submit", function (e) { e.preventDefault(); go(q.value); });

  var ideas = ["plastic containers", "injection moulding machine", "automotive parts", "steel fasteners", "cargo insurance", "packaging film"];
  var i = 0;
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setInterval(function () {
      if (document.activeElement !== q && !q.value) { i = (i + 1) % ideas.length; q.placeholder = ideas[i]; }
    }, 2600);
  }

  var quick = ["Plastics & Packaging", "Machinery", "Electronics & Components", "Automotive"];
  $("chips").innerHTML = quick.map(function (x) { return '<button type="button" class="chipbtn">' + esc(x) + "</button>"; }).join("");
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b) go(b.textContent);
  });

  /* folders from the live category list */
  SD.catalog().then(function (c) {
    var list = c.categories.slice(0, 11);
    $("folders").innerHTML = list.map(function (x, n) {
      return '<a class="folder" data-n="' + String(n + 1).padStart(2, "0") + '" href="search.html?category=' + encodeURIComponent(x) + '">' + esc(x) + "</a>";
    }).join("") + '<a class="folder" data-n="All" href="categories.html">All ' + c.categories.length + " categories →</a>";
  });

  /* draggable sticky notes */
  document.querySelectorAll("[data-drag]").forEach(SD.drag);

  /* live data */
  Promise.all([SD.api("/api/products"), SD.api("/api/suppliers")]).then(function (res) {
    var prods = (res[0].data && res[0].data.products) || [];
    var sups = (res[1].data && res[1].data.suppliers) || [];
    if (!res[0].ok && !res[1].ok) throw new Error("offline");
    SD.count($("n1"), prods.length);
    SD.count($("n2"), sups.length);
    var countries = {};
    prods.concat(sups).forEach(function (x) { if (x.country) countries[x.country] = 1; });
    SD.count($("n3"), Object.keys(countries).length);

    if (!prods.length) {
      $("note").textContent = "New listings are pinned here once they are approved.";
      $("cards").innerHTML = '<div class="msg">Nothing pinned yet. <a href="supplier-register.html">Be the first supplier on the desk.</a></div>';
      return;
    }
    $("note").textContent = "The latest approved products, pinned by suppliers.";
    var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("cards").innerHTML = prods.slice(0, 8).map(function (x, n) {
      var rot = ((n * 37) % 9 - 4) * 0.9;
      var pic = x.imageUrl
        ? '<img loading="lazy" src="' + esc(x.imageUrl) + '" alt="' + esc(x.name) + '">'
        : esc((x.name || "?").charAt(0).toUpperCase());
      return '<a class="pcard drop-in" href="product.html?id=' + encodeURIComponent(x.id) + '" style="--rot:' + rot + "deg;animation-delay:" + (still ? 0 : n * 90) + 'ms">' +
        '<div class="pic">' + pic + "</div><h3>" + esc(x.name) + "</h3><p>" + esc(x.city) + ", " + esc(x.country) + "</p>" +
        (x.moq ? '<span class="tag">MOQ ' + esc(x.moq) + "</span>" : "") + "</a>";
    }).join("");
    document.querySelectorAll("#cards .pcard").forEach(SD.drag);
  }).catch(function () {
    $("note").textContent = "Listings could not load right now.";
    $("cards").innerHTML = '<div class="msg"><a href="search.html">Open search</a> to browse everything.</div>';
  });
})();
