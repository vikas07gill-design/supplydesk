/* Buyer dashboard: enquiries, requirements, quotations and profile. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var token = SD.buyerToken();
  if (!token) { location.href = "index.html"; return; }
  var headers = { "x-buyer-dashboard-token": token };

  function say(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  /* only an expired or invalid sign-in sends the buyer away; a network hiccup does not */
  function expired() { SD.clearBuyerToken(); location.href = "index.html"; }

  function load() {
    SD.api("/api/buyer-dashboard", { headers: headers }).then(function (r) {
      if (r.status === 401) { expired(); return; }
      if (!r.ok) throw new Error("load");
      var buyer = r.data.buyer || {}, enquiries = r.data.enquiries || [];
      say($("loadError"), "");
      $("who").textContent = buyer.email || "your desk";
      var fields = { pname: "name", pcompany: "company", pcountry: "country", pphone: "phone" };
      Object.keys(fields).forEach(function (id) { $(id).value = buyer[fields[id]] || ""; });
      $("total").textContent = enquiries.length;
      $("active").textContent = enquiries.filter(function (x) { return x.status !== "closed"; }).length;
      $("closed").textContent = enquiries.filter(function (x) { return x.status === "closed"; }).length;
      $("rows").innerHTML = enquiries.map(function (x) {
        var st = String(x.status || "new");
        return "<tr><td><strong>" + esc(x.productName) + "</strong></td><td>" + esc(x.supplierName) + "</td><td>" +
          esc(((x.supplierCity || "") + " " + (x.supplierCountry || "")).trim()) + "</td><td>" + esc(x.quantity || "—") +
          '</td><td><span class="pill ' + esc(st) + '">' + esc(st.replace(/_/g, " ")) + "</span></td><td>" +
          esc(new Date(x.createdAt).toLocaleDateString()) + "</td></tr>";
      }).join("");
      $("empty").style.display = enquiries.length ? "none" : "block";
      loadRequirements();
    }).catch(function () {
      say($("loadError"), "We could not load your dashboard right now. Check your connection and refresh the page.", "error");
    });
  }

  function loadRequirements() {
    var box = $("requirements");
    SD.api("/api/buyer-requirements", { headers: headers }).then(function (r) {
      if (r.status === 401) { expired(); return; }
      if (!r.ok) throw new Error("load");
      var items = r.data.requirements || [];
      if (!items.length) { box.innerHTML = '<div class="empty">No requirements posted yet.</div>'; return; }
      box.innerHTML = items.map(function (x) {
        return '<div class="req-item"><div class="top"><strong>' + esc(x.title) + '</strong><span class="pill ' + esc(x.status) + '">' + esc(x.status) + "</span></div>" +
          '<div class="meta">Qty: ' + esc(x.quantity || "Not specified") + (x.unit ? " " + esc(x.unit) : "") + " · " + esc(x.category || "Custom") +
          (x.delivery_country ? " · " + esc(x.delivery_country) : "") + "</div>" +
          '<div class="meta"><b>' + esc(x.quote_count || 0) + "</b> quotation(s) received</div>" +
          '<button class="btn sm y" style="margin-top:12px" type="button" data-quotes="' + esc(x.id) + '">View quotations</button></div>';
      }).join("");
    }).catch(function () { box.innerHTML = '<div class="empty">Could not load requirements.</div>'; });
  }

  $("requirements").addEventListener("click", function (e) {
    var b = e.target.closest("[data-quotes]");
    if (b) showQuotes(b.getAttribute("data-quotes"), b);
  });

  function showQuotes(id, opener) {
    SD.api("/api/buyer-requirements/" + encodeURIComponent(id) + "/quotes", { headers: headers }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "Could not load quotations.");
      var quotes = r.data.quotes || [];
      var html = quotes.length ? quotes.map(function (q) {
        return '<div style="border-top:2px solid var(--line);padding:14px 0"><strong>' + esc(q.trade_name || q.legal_name) + "</strong>" +
          '<div style="font-size:14px;margin-top:6px">Price: <b>' + esc(q.unit_price) + " " + esc(q.currency) + "</b> · MOQ: " + esc(q.moq || "—") + " · Lead time: " + esc(q.lead_time || "—") + "</div>" +
          '<div style="font-size:13px;color:var(--muted);margin-top:4px">' + esc(q.payment_terms || "Payment terms not specified") + (q.incoterm ? " · " + esc(q.incoterm) : "") + (q.notes ? " · " + esc(q.notes) : "") + "</div></div>";
      }).join("") : '<div class="empty">No quotations yet. Suppliers appear here once they quote.</div>';
      var m = document.createElement("div");
      m.className = "modal show"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
      m.innerHTML = '<div class="mcard"><button class="mclose" type="button" aria-label="Close">×</button><h2>Quotations</h2><p>' +
        esc((r.data.requirement && r.data.requirement.title) || "Requirement") + "</p>" + html + "</div>";
      function close() { m.remove(); document.removeEventListener("keydown", onKey); if (opener) opener.focus(); }
      function onKey(e) { if (e.key === "Escape") close(); }
      m.addEventListener("mousedown", function (e) { if (e.target === m) close(); });
      m.querySelector(".mclose").addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(m);
      m.querySelector(".mclose").focus();
    }).catch(function (err) {
      say($("loadError"), err.message, "error");
    });
  }

  $("save").addEventListener("click", function () {
    var s = $("status"), btn = $("save");
    btn.disabled = true;
    SD.api("/api/buyer-dashboard/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-buyer-dashboard-token": token },
      body: JSON.stringify({ name: $("pname").value.trim(), company: $("pcompany").value.trim(), country: $("pcountry").value.trim(), phone: $("pphone").value.trim() })
    }).then(function (r) {
      say(s, r.ok ? "Profile saved." : (r.data.error || "Could not save your profile."), r.ok ? "success" : "error");
    }).catch(function () { say(s, "Could not save your profile.", "error"); })
      .then(function () { btn.disabled = false; });
  });

  $("logout").addEventListener("click", function () {
    SD.api("/api/buyer-dashboard/logout", { method: "POST", headers: headers }).catch(function () {}).then(function () {
      SD.clearBuyerToken(); location.href = "index.html";
    });
  });

  load();
})();
