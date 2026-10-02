/* Keeps a logged-in buyer logged in across the public pages:
   swaps the nav "Login" / "Sign Up" links for "My Dashboard" / "Logout" while a valid buyer session exists. */
(function () {
  var KEY = "supplydesk_buyer_dashboard_token";
  var token = "";
  try { token = localStorage.getItem(KEY) || ""; } catch (e) {}
  if (!token) return;

  var changed = [];
  function swap() {
    var links = document.querySelectorAll('a[href^="buyer-login.html"]');
    links.forEach(function (a) {
      if (a.dataset.authSwapped) return;
      var signup = /mode=signup/.test(a.getAttribute("href"));
      a.dataset.authSwapped = "1";
      a.dataset.origHref = a.getAttribute("href");
      a.dataset.origText = a.textContent;
      if (signup) {
        a.textContent = "Logout";
        a.setAttribute("href", "#logout");
        a.classList.remove("primary");
        a.addEventListener("click", logout);
      } else {
        a.textContent = "My Dashboard";
        a.setAttribute("href", "buyer-dashboard.html");
      }
      changed.push(a);
    });
  }
  function restore() {
    changed.forEach(function (a) {
      a.setAttribute("href", a.dataset.origHref);
      a.textContent = a.dataset.origText;
      a.removeEventListener("click", logout);
      delete a.dataset.authSwapped;
    });
    changed = [];
  }
  function logout(e) {
    e.preventDefault();
    fetch("/api/buyer-dashboard/logout", { method: "POST", headers: { "x-buyer-dashboard-token": token } })
      .catch(function () {})
      .then(function () { try { localStorage.removeItem(KEY); } catch (x) {} location.href = "index.html"; });
  }
  function run() {
    swap();
    // confirm the session is still valid; if not, put Login back
    fetch("/api/buyer-dashboard", { headers: { "x-buyer-dashboard-token": token } })
      .then(function (r) { if (r.status === 401 || r.status === 403) { try { localStorage.removeItem(KEY); } catch (x) {} restore(); } })
      .catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
