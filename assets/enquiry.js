/* Enquiry pop-up shared by the product and supplier pages.
   Flow: verify email with a one-time code, then send the enquiry through
   /api/connect-requests. The email stays verified for follow-up enquiries. */
(function () {
  "use strict";
  var $ = SD.$, esc = SD.esc;
  var built = false, ctx = {}, trigger = null;
  var verificationToken = "", dashboardToken = SD.buyerToken(), sessionChecked = false;

  var HTML =
    '<div class="mcard" role="document">' +
    '<button class="mclose" id="enqClose" type="button" aria-label="Close">×</button>' +
    '<h2 id="enqTitle">Connect with this supplier</h2>' +
    '<p id="enqIntro">Send your requirement directly to the supplier.</p>' +
    '<form id="enqForm" novalidate>' +
    '<div class="fgrid">' +
    '<div class="field full"><label for="enqName">Your name *</label><input id="enqName" required maxlength="180" autocomplete="name"></div>' +
    '<div class="field full"><label for="enqEmail">Email *</label>' +
    '<div class="otp-row"><input id="enqEmail" type="email" required maxlength="255" autocomplete="email" placeholder="you@company.com"><button class="btn" id="enqSend" type="button">Send code</button></div>' +
    '<div id="enqOtpRow" class="otp-row" style="display:none;margin-top:10px"><input id="enqOtp" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code"><button class="btn" id="enqVerify" type="button">Verify</button></div>' +
    '<div class="verified-mark" id="enqVerified">✓ Email verified</div></div>' +
    '<div class="field"><label for="enqCompany">Company</label><input id="enqCompany" maxlength="180" autocomplete="organization"></div>' +
    '<div class="field"><label for="enqCountry">Country</label><input id="enqCountry" maxlength="120" autocomplete="country-name"></div>' +
    '<div class="field"><label for="enqPhone">Phone</label><input id="enqPhone" maxlength="80" autocomplete="tel"></div>' +
    '<div class="field"><label for="enqQty">Quantity</label><input id="enqQty" maxlength="120" placeholder="e.g. 5,000 pcs / monthly"></div>' +
    '<div class="field full" id="enqProductRow"><label for="enqProduct">Product or requirement</label><input id="enqProduct" maxlength="255"></div>' +
    '<div class="field full"><label for="enqMessage">Message</label><textarea id="enqMessage" maxlength="2000" placeholder="Tell the supplier what you need…"></textarea></div>' +
    "</div>" +
    '<div class="status" id="enqStatus" role="status" aria-live="polite"></div>' +
    '<div class="mactions"><a class="btn" id="enqDash" href="buyer-dashboard.html" style="display:none">My enquiries</a>' +
    '<button class="btn" type="button" id="enqCancel">Cancel</button>' +
    '<button class="btn r" id="enqSubmit" type="submit">Send enquiry</button></div>' +
    "</form></div>";

  function status(msg, kind) {
    var s = $("enqStatus");
    s.textContent = msg || "";
    s.className = "status" + (kind ? " " + kind : "");
  }

  function markVerified(email) {
    $("enqEmail").value = email || $("enqEmail").value;
    $("enqEmail").readOnly = true;
    $("enqVerified").classList.add("show");
    $("enqOtpRow").style.display = "none";
    $("enqSend").textContent = "Verified ✓";
    $("enqSend").disabled = true;
  }

  function restoreSession() {
    if (sessionChecked || !dashboardToken) return;
    sessionChecked = true;
    SD.api("/api/buyer-dashboard", { headers: { "x-buyer-dashboard-token": dashboardToken } }).then(function (r) {
      if (r.status === 401) { SD.clearBuyerToken(); dashboardToken = ""; return; }
      var b = r.ok && r.data && r.data.buyer;
      if (!b || !b.email) return;
      markVerified(b.email);
      if (b.name && !$("enqName").value) $("enqName").value = b.name;
      if (b.company && !$("enqCompany").value) $("enqCompany").value = b.company;
      if (b.country && !$("enqCountry").value) $("enqCountry").value = b.country;
      if (b.phone && !$("enqPhone").value) $("enqPhone").value = b.phone;
    });
  }

  function sendCode() {
    var email = $("enqEmail").value.trim().toLowerCase();
    var btn = $("enqSend");
    if (!/^\S+@\S+\.\S+$/.test(email)) { status("Enter a valid email address first.", "error"); return; }
    btn.disabled = true; btn.textContent = "Sending…";
    SD.api("/api/buyer-email/request-otp", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "Could not send the code.");
      $("enqOtpRow").style.display = "flex";
      $("enqOtp").focus();
      btn.textContent = "Code sent";
      status("We sent a 6-digit code to " + email + ". Enter it below and press Verify.", "neutral");
    }).catch(function (err) {
      status(err.message || "Could not send the code.", "error");
      btn.disabled = false; btn.textContent = "Send code";
    });
  }

  function verifyCode() {
    var email = $("enqEmail").value.trim().toLowerCase();
    var otp = $("enqOtp").value.trim();
    var btn = $("enqVerify");
    if (!/^\d{6}$/.test(otp)) { status("Enter the 6-digit code.", "error"); return; }
    btn.disabled = true; btn.textContent = "Verifying…";
    SD.api("/api/buyer-email/verify-otp", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, otp: otp })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "That code did not work.");
      verificationToken = r.data.verificationToken || "";
      dashboardToken = r.data.dashboardToken || "";
      SD.setBuyerToken(dashboardToken);
      markVerified(email);
      status("Email verified. You can send your enquiry now.", "success");
    }).catch(function (err) {
      status(err.message || "That code did not work.", "error");
      btn.disabled = false; btn.textContent = "Verify";
    });
  }

  function submit(e) {
    e.preventDefault();
    var form = $("enqForm");
    if (!form.checkValidity()) { form.reportValidity(); return; }
    if (!$("enqVerified").classList.contains("show")) { status("Verify your email first, then send the enquiry.", "error"); return; }
    var btn = $("enqSubmit");
    btn.disabled = true; btn.textContent = "Sending…";
    status("");
    var body = {
      supplierId: ctx.supplierId || "",
      productId: ctx.productId || "",
      productName: $("enqProduct").value.trim() || ctx.productName || "",
      customerName: $("enqName").value.trim(),
      customerEmail: $("enqEmail").value.trim(),
      customerCompany: $("enqCompany").value.trim(),
      customerCountry: $("enqCountry").value.trim(),
      customerPhone: $("enqPhone").value.trim(),
      quantity: $("enqQty").value.trim(),
      message: $("enqMessage").value.trim(),
      sourceAction: ctx.action || "contact",
      verificationToken: verificationToken,
      dashboardToken: dashboardToken
    };
    SD.api("/api/connect-requests", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error((r.data.error || "Could not send the enquiry.") + (r.data.requestId ? " [Request ID: " + r.data.requestId + "]" : ""));
      status(r.data.message || "Enquiry sent. The supplier has been notified.", "success");
      $("enqDash").style.display = "inline-flex";
      /* keep the verified buyer details; clear only what belongs to this enquiry */
      $("enqMessage").value = ""; $("enqQty").value = "";
      btn.textContent = "Send another enquiry";
      btn.disabled = false;
    }).catch(function (err) {
      status(err.message || "Could not send the enquiry.", "error");
      btn.disabled = false; btn.textContent = "Send enquiry";
    });
  }

  function close() {
    var m = $("enqModal");
    if (!m) return;
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (trigger && trigger.focus) trigger.focus();
  }

  function build() {
    if (built) return;
    built = true;
    var m = document.createElement("div");
    m.className = "modal"; m.id = "enqModal";
    m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
    m.setAttribute("aria-labelledby", "enqTitle"); m.setAttribute("aria-hidden", "true");
    m.innerHTML = HTML;
    document.body.appendChild(m);
    $("enqSend").addEventListener("click", sendCode);
    $("enqVerify").addEventListener("click", verifyCode);
    $("enqForm").addEventListener("submit", submit);
    $("enqClose").addEventListener("click", close);
    $("enqCancel").addEventListener("click", close);
    m.addEventListener("mousedown", function (e) { if (e.target === m) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  window.SDEnquiry = {
    open: function (opts) {
      build();
      ctx = opts || {};
      trigger = document.activeElement;
      $("enqTitle").textContent = ctx.title || "Connect with this supplier";
      $("enqIntro").textContent = ctx.intro || "Your enquiry is sent to the supplier by SupplyDesk. Their direct contact details stay private.";
      $("enqProduct").value = ctx.productName || "";
      $("enqProductRow").style.display = ctx.hideProduct ? "none" : "";
      $("enqSubmit").textContent = "Send enquiry";
      $("enqSubmit").disabled = false;
      status("");
      var m = $("enqModal");
      m.classList.add("show");
      m.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
      restoreSession();
      $("enqName").focus();
    },
    close: close
  };
})();
