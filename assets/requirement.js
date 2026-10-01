/* Post-a-requirement page. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var dashboardToken = SD.buyerToken();
  var verified = false;
  var cat = $("category"), sub = $("subcategory");
  var subs = {};

  function setStatus(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  /* all categories and their sub-categories come from the server catalogue */
  SD.catalog().then(function (c) {
    subs = c.subs;
    cat.insertAdjacentHTML("beforeend", c.categories.map(function (x) { return "<option>" + esc(x) + "</option>"; }).join(""));
  });
  cat.addEventListener("change", function () {
    sub.innerHTML = '<option value="">Select sub-category</option>' +
      (subs[cat.value] || []).map(function (x) { return "<option>" + esc(x) + "</option>"; }).join("");
  });

  function markVerified(email) {
    verified = true;
    if (email) $("email").value = email;
    $("email").readOnly = true;
    setStatus($("verifyStatus"), "✓ Email verified. You can submit the requirement.", "success");
  }

  /* a returning buyer who is already signed in does not need to verify again */
  if (dashboardToken) {
    SD.api("/api/buyer-dashboard", { headers: { "x-buyer-dashboard-token": dashboardToken } }).then(function (r) {
      if (r.status === 401) { SD.clearBuyerToken(); dashboardToken = ""; return; }
      var b = r.ok && r.data && r.data.buyer;
      if (!b || !b.email) return;
      if (b.name && !$("name").value) $("name").value = b.name;
      if (b.company && !$("company").value) $("company").value = b.company;
      if (b.country && !$("country").value) $("country").value = b.country;
      if (b.phone && !$("phone").value) $("phone").value = b.phone;
      markVerified(b.email);
    });
  }

  $("sendOtp").addEventListener("click", function () {
    var email = $("email").value.trim().toLowerCase(), s = $("verifyStatus"), b = $("sendOtp");
    if (!/^\S+@\S+\.\S+$/.test(email)) { setStatus(s, "Enter a valid email address.", "error"); return; }
    b.disabled = true; b.textContent = "Sending…";
    SD.api("/api/buyer-email/request-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email }) })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || "Could not send the code.");
        if (r.data.testOtp) $("otp").value = r.data.testOtp;
        setStatus(s, r.data.message || "We sent a 6-digit code to your email.", "success");
      })
      .catch(function (e) { setStatus(s, e.message, "error"); })
      .then(function () { b.disabled = false; b.textContent = "Resend code"; });
  });

  $("verifyOtp").addEventListener("click", function () {
    var email = $("email").value.trim().toLowerCase(), otp = $("otp").value.trim(), s = $("verifyStatus"), b = $("verifyOtp");
    if (!/^\d{6}$/.test(otp)) { setStatus(s, "Enter the 6-digit code.", "error"); return; }
    b.disabled = true; b.textContent = "Verifying…";
    SD.api("/api/buyer-email/verify-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, otp: otp }) })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || "Verification failed.");
        dashboardToken = r.data.dashboardToken;
        SD.setBuyerToken(dashboardToken);
        markVerified(email);
      })
      .catch(function (e) { verified = false; setStatus(s, e.message, "error"); })
      .then(function () { b.disabled = false; b.textContent = "Verify"; });
  });

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = $("form"), result = $("result");
    if (!form.checkValidity()) { form.reportValidity(); return; }
    if (!verified || !dashboardToken) {
      setStatus(result, "Please verify your email first.", "error");
      $("email").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    var b = $("submit");
    b.disabled = true; b.textContent = "Submitting…";
    var body = {
      dashboardToken: dashboardToken,
      buyerName: $("name").value.trim(),
      buyerCompany: $("company").value.trim(),
      buyerCountry: $("country").value.trim(),
      buyerPhone: $("phone").value.trim(),
      requirementType: $("type").value,
      title: $("reqTitle").value.trim(),
      category: cat.value,
      subcategory: sub.value,
      description: $("description").value.trim(),
      quantity: $("quantity").value.trim(),
      unit: $("unit").value.trim(),
      targetPrice: $("price").value,
      currency: $("currency").value,
      deliveryCountry: $("deliveryCountry").value.trim(),
      deliveryCity: $("deliveryCity").value.trim(),
      requiredBy: $("requiredBy").value,
      marketScope: $("market").value
    };
    SD.api("/api/buyer-requirements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || "Could not submit the requirement.");
        result.innerHTML = "✓ " + esc(r.data.message || "Requirement submitted.") + " Reference: " + esc(r.data.requirementId || "") +
          '. <a href="buyer-dashboard.html" style="text-decoration:underline">See it in My enquiries</a>';
        result.className = "status success";
        b.textContent = "Requirement submitted";
      })
      .catch(function (err) {
        setStatus(result, err.message, "error");
        b.disabled = false; b.textContent = "Submit requirement";
      });
  });
})();
