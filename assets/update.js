/* Supplier profile update page (opened from the emailed secure link). */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var token = new URLSearchParams(location.search).get("token");
  var cat = $("category"), sub = $("subcategory");
  var subs = SD.FALLBACK_CATALOG;

  function say(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  cat.insertAdjacentHTML("beforeend", Object.keys(SD.GROUPS).map(function (g) {
    return '<optgroup label="' + esc(g) + '">' + SD.GROUPS[g].map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + "</option>"; }).join("") + "</optgroup>";
  }).join(""));

  function fillSub(selected) {
    sub.innerHTML = '<option value="">Keep current</option>' +
      (subs[cat.value] || []).map(function (x) { return '<option value="' + esc(x) + '"' + (x === selected ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("");
  }
  cat.addEventListener("change", function () { fillSub(""); });
  SD.catalog().then(function (c) { subs = c.subs; fillSub(sub.value); });

  function loadProfile() {
    if (!token) return;
    SD.api("/api/supplier-update/" + encodeURIComponent(token)).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "This update link has expired. Request a new one.");
      $("requestCard").classList.add("hidden");
      $("updateCard").classList.remove("hidden");
      var s = r.data.supplier, f = $("updateForm");
      var map = { legalName: s.legalName, tradeName: s.tradeName, businessType: s.businessType, country: s.country, city: s.city,
        address: s.address, email: s.email, phone: s.phone, contact: s.contact, designation: s.designation, website: s.website };
      Object.keys(map).forEach(function (k) { if (f.elements[k]) f.elements[k].value = map[k] || ""; });
      cat.value = s.category || "";
      fillSub(s.subcategory || "");
    }).catch(function (e) { say($("requestStatus"), e.message, "error"); });
  }

  $("requestForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var s = $("requestStatus");
    say(s, "Sending your secure link…", "neutral");
    SD.api("/api/supplier-update/request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("requestEmail").value })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "Could not send the link.");
      say(s, r.data.message || "If this email is registered, an update link has been sent.", "success");
    }).catch(function (err) { say(s, err.message, "error"); });
  });

  $("updateForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget, s = $("updateStatus"), btn = form.querySelector("button[type=submit]");
    say(s, "Submitting your update for verification…", "neutral");
    btn.disabled = true;
    fetch("/api/supplier-update/" + encodeURIComponent(token), { method: "POST", body: new FormData(form) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || "Update failed.");
        say(s, r.data.message || "Update submitted for verification.", "success");
        form.querySelectorAll("input,select,textarea,button").forEach(function (x) { x.disabled = true; });
      })
      .catch(function (err) { say(s, err.message, "error"); btn.disabled = false; });
  });

  loadProfile();
})();
