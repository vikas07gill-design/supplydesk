/* Supplier registration page. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var cat = $("category"), sub = $("subcategory");
  var subs = SD.FALLBACK_CATALOG;

  function fillSub() {
    sub.innerHTML = '<option value="">Select sub-category</option>' +
      (subs[cat.value] || ["Other / General"]).map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + "</option>"; }).join("");
  }

  /* categories are grouped; sub-categories come from the server catalogue */
  cat.innerHTML = '<option value="">Select category</option>' + Object.keys(SD.GROUPS).map(function (g) {
    return '<optgroup label="' + esc(g) + '">' + SD.GROUPS[g].map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + "</option>"; }).join("") + "</optgroup>";
  }).join("");
  fillSub();
  cat.addEventListener("change", fillSub);
  SD.catalog().then(function (c) { subs = c.subs; fillSub(); });

  var toggle = $("requestToggle"), box = $("requestBox");
  function showRequest(show) {
    box.classList.toggle("hidden", !show);
    toggle.setAttribute("aria-expanded", String(show));
  }
  toggle.addEventListener("click", function () { showRequest(box.classList.contains("hidden")); });
  if (location.hash === "#category-request") showRequest(true);

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = $("form"), s = $("status");
    if (!form.checkValidity()) { form.reportValidity(); return; }
    var btn = form.querySelector('button[type="submit"]');
    s.className = "status";
    s.innerHTML = "<strong>Submitting…</strong> Please wait while your application and files are uploaded.";
    btn.disabled = true; btn.textContent = "Submitting…";
    fetch("/api/supplier-applications", { method: "POST", body: new FormData(form) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || "Submission failed. Please try again.");
        s.className = "status success";
        s.innerHTML = "<strong>Application submitted ✓</strong><br>" + esc(r.data.message || "") +
          '<br><span class="hint">Application reference: ' + esc(r.data.applicationId || "") + "</span>";
        form.querySelectorAll("input,select,textarea,button").forEach(function (el) { el.disabled = true; });
        s.scrollIntoView({ behavior: "smooth", block: "center" });
      })
      .catch(function (err) {
        s.className = "status error";
        s.innerHTML = "<strong>We could not submit the application.</strong><br>" + esc(err.message) + '<br><span class="hint">Check your details and try again.</span>';
        btn.disabled = false; btn.textContent = "Submit for verification";
      });
  });
})();
