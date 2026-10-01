/* Search page: tabs, filters and results. Filtering runs in the browser on the
   approved listings returned by /api/products and /api/suppliers. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var params = new URLSearchParams(location.search);
  var data = [];
  var subsByCategory = {};
  var active = params.get("type") || "all";
  if (["all", "product", "supplier", "service"].indexOf(active) < 0) active = "all";

  var el = {
    q: $("q"), category: $("category"), subcategory: $("subcategory"), country: $("country"),
    city: $("city"), market: $("market"), sort: $("sort"), summary: $("summary"), results: $("results"), title: $("title")
  };

  el.q.value = params.get("q") || "";
  el.market.value = params.get("market") || "";
  el.sort.value = params.get("sort") === "name" ? "name" : "newest";

  var wanted = {
    category: params.get("category") || "",
    subcategory: params.get("subcategory") || "",
    country: params.get("country") || params.get("from") || "",
    city: params.get("city") || ""
  };

  function isService(x) { return x.type === "supplier" && SD.SERVICE_CATEGORIES.indexOf(x.category) >= 0; }

  function setTabs() {
    document.querySelectorAll(".tab").forEach(function (b) {
      var on = b.dataset.type === active;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
  }
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { active = b.dataset.type; setTabs(); render(); });
  });
  setTabs();

  function fillOptions(select, values, placeholder, keep) {
    var chosen = keep !== undefined ? keep : select.value;
    select.innerHTML = '<option value="">' + esc(placeholder) + "</option>" +
      values.map(function (v) { return "<option>" + esc(v) + "</option>"; }).join("");
    if (chosen && values.indexOf(chosen) < 0) { select.insertAdjacentHTML("beforeend", "<option>" + esc(chosen) + "</option>"); }
    select.value = chosen || "";
  }

  function fillSubcategories(keep) {
    var subs = subsByCategory[el.category.value] || [];
    fillOptions(el.subcategory, subs, "Any sub-category", keep || "");
  }

  function fillPlaces() {
    var countries = {}, cities = {};
    data.forEach(function (x) {
      if (x.country) countries[x.country] = 1;
      if (x.city && (!el.country.value || x.country === el.country.value)) cities[x.city] = 1;
    });
    fillOptions(el.country, Object.keys(countries).sort(), "Any country", el.country.value || wanted.country);
    fillOptions(el.city, Object.keys(cities).sort(), "Any city", el.city.value || wanted.city);
  }

  function matches(x, q) {
    if (!q) return true;
    var hay = [x.name, x.desc, (x.tags || []).join(" "), x.city, x.country, x.category, x.supplierName].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  function marketOk(x, market) {
    if (!market) return true;
    /* only products carry a real market scope; supplier listings pass through */
    if (["Domestic", "International", "Both"].indexOf(x.market) < 0) return true;
    return x.market === market || x.market === "Both";
  }

  function filtered() {
    var q = el.q.value.trim(), cat = el.category.value, sub = el.subcategory.value,
        country = el.country.value, city = el.city.value, market = el.market.value;
    var rows = data.filter(function (x) {
      if (active === "product" && x.type !== "product") return false;
      if (active === "supplier" && x.type !== "supplier") return false;
      if (active === "service" && !isService(x)) return false;
      if (cat && x.category !== cat) return false;
      if (sub && !(x.subcategories || []).some(function (s) { return s === sub; })) return false;
      if (country && x.country !== country) return false;
      if (city && x.city !== city) return false;
      if (!marketOk(x, market)) return false;
      return matches(x, q);
    });
    if (el.sort.value === "name") rows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return rows;
  }

  function target(x) {
    return (x.type === "product" ? "product.html?id=" : "supplier.html?id=") + encodeURIComponent(x.id);
  }

  function productCard(x, n) {
    var rot = ((n * 37) % 9 - 4) * 0.7;
    var pic = x.imageUrl
      ? '<img loading="lazy" src="' + esc(x.imageUrl) + '" alt="' + esc(x.name) + '">'
      : esc((x.name || "?").charAt(0).toUpperCase());
    return '<a class="pcard" style="--rot:' + rot + 'deg" href="' + target(x) + '">' +
      '<div class="pic">' + pic + "</div>" +
      "<h3>" + esc(x.name) + "</h3>" +
      "<p>" + esc(x.city) + ", " + esc(x.country) + (x.market ? " · " + esc(x.market) : "") + "</p>" +
      (x.desc ? '<p class="desc">' + esc(x.desc) + "</p>" : "") +
      (x.moq ? '<span class="tag">MOQ ' + esc(x.moq) + (x.unit ? " " + esc(x.unit) : "") + "</span>" : "") +
      '<span class="go">View product →</span></a>';
  }

  function supplierRow(x) {
    var svc = isService(x);
    return '<a class="irow" href="' + target(x) + '"><div>' +
      '<span class="kind">' + (svc ? "Service provider" : "Supplier") + (x.verified ? " · Verified" : "") + "</span>" +
      "<h3>" + esc(x.name) + "</h3>" +
      '<div class="meta">' + esc(x.city) + ", " + esc(x.country) + (x.category ? " · " + esc(x.category) : "") + "</div>" +
      (x.desc ? '<div class="desc">' + esc(x.desc) + "</div>" : "") +
      '<div class="tags">' + (x.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div>" +
      '</div><span class="btn y sm">View ' + (svc ? "provider" : "supplier") + " →</span></a>";
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (el.q.value.trim()) p.set("q", el.q.value.trim());
    if (active !== "all") p.set("type", active);
    if (el.category.value) p.set("category", el.category.value);
    if (el.subcategory.value) p.set("subcategory", el.subcategory.value);
    if (el.country.value) p.set("country", el.country.value);
    if (el.city.value) p.set("city", el.city.value);
    if (el.market.value) p.set("market", el.market.value);
    if (el.sort.value === "name") p.set("sort", "name");
    var qs = p.toString();
    try { history.replaceState(null, "", "search.html" + (qs ? "?" + qs : "")); } catch (e) {}
  }

  var loaded = false, failed = false;
  function render() {
    var q = el.q.value.trim();
    el.title.textContent = q ? "Results for “" + q + "”" : "Search the desk";
    document.title = (q ? q + " | " : "Search | ") + "SupplyDesk";
    syncUrl();
    if (!loaded) { el.summary.textContent = "Loading listings…"; return; }

    if (failed) {
      el.summary.textContent = "";
      el.results.innerHTML = '<div class="sheet" style="text-align:center"><h2>Listings could not load</h2><p>Check your connection and try again in a moment.</p><button class="btn r" type="button" id="retry">Reload</button></div>';
      $("retry").addEventListener("click", function () { location.reload(); });
      return;
    }
    var rows = filtered();
    el.summary.textContent = rows.length + " result" + (rows.length === 1 ? "" : "s");

    if (!rows.length) {
      el.results.innerHTML = '<div class="sheet" style="text-align:center"><h2>No exact matches yet</h2>' +
        "<p>Try a broader term, another market, or clear the filters. You can also post a requirement and let suppliers come to you.</p>" +
        '<div class="btnrow" style="justify-content:center;margin-top:14px"><button class="btn" type="button" id="emptyClear">Clear filters</button>' +
        '<a class="btn r" href="requirement.html">Post a requirement</a></div></div>';
      var c = $("emptyClear"); if (c) c.addEventListener("click", clearFilters);
      return;
    }

    var products = rows.filter(function (x) { return x.type === "product"; });
    var others = rows.filter(function (x) { return x.type !== "product"; });
    var html = "";
    if (products.length) {
      if (others.length) html += '<div class="group-title"><h2>Products</h2></div>';
      html += '<div class="cards">' + products.map(productCard).join("") + "</div>";
    }
    if (others.length) {
      html += '<div class="group-title" style="margin-top:' + (products.length ? 54 : 0) + 'px"><h2>' + (active === "service" ? "Service providers" : "Suppliers") + "</h2></div>" +
        '<div class="rows">' + others.map(supplierRow).join("") + "</div>";
    }
    el.results.innerHTML = html;
  }

  function clearFilters() {
    el.q.value = "";
    el.category.value = ""; fillSubcategories("");
    wanted = { category: "", subcategory: "", country: "", city: "" };
    el.country.value = ""; el.city.value = ""; el.market.value = ""; el.sort.value = "newest";
    active = "all"; setTabs(); fillPlaces(); render();
  }

  $("searchForm").addEventListener("submit", function (e) { e.preventDefault(); render(); });
  $("clear").addEventListener("click", clearFilters);
  el.category.addEventListener("change", function () { fillSubcategories(""); render(); });
  el.country.addEventListener("change", function () { el.city.value = ""; wanted.city = ""; fillPlaces(); render(); });
  [el.subcategory, el.city, el.market, el.sort].forEach(function (s) { s.addEventListener("change", render); });

  /* categories first, so ?category= from the home folders can be selected */
  SD.catalog().then(function (c) {
    subsByCategory = c.subs;
    fillOptions(el.category, c.categories, "Any category", wanted.category);
    fillSubcategories(wanted.subcategory);
    render();
  });

  Promise.all([SD.api("/api/suppliers"), SD.api("/api/products")]).then(function (res) {
    var suppliers = (res[0].data && res[0].data.suppliers) || [];
    var products = (res[1].data && res[1].data.products) || [];
    failed = !res[0].ok && !res[1].ok;
    data = suppliers.concat(products).map(function (x) {
      x.market = x.market || "All markets";
      return x;
    });
    loaded = true;
    fillPlaces();
    render();
  });
})();
