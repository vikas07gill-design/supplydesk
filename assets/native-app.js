/* SupplyDesk mobile app (Capacitor) helpers. Does nothing in a normal browser. */
(function () {
  var cap = window.Capacitor;
  if (!cap || !(cap.isNativePlatform ? cap.isNativePlatform() : cap.getPlatform && cap.getPlatform() !== "web")) return;
  var root = document.documentElement;
  root.classList.add("native-app", "native-" + (cap.getPlatform ? cap.getPlatform() : "app"));
  var css = document.createElement("style");
  css.textContent =
    "html.native-app nav,html.native-app header{padding-top:env(safe-area-inset-top)}" +
    "html.native-app nav{height:auto!important;min-height:70px}" +
    "html.native-app body{padding-bottom:env(safe-area-inset-bottom)}" +
    "html.native-app a,html.native-app button{-webkit-tap-highlight-color:transparent}" +
    "html.native-app .native-hide{display:none!important}";
  document.head.appendChild(css);
  // Status bar colour to match the dark header
  try { var sb = cap.Plugins && cap.Plugins.StatusBar; if (sb) { sb.setStyle({ style: "DARK" }); if (cap.getPlatform() === "android") sb.setBackgroundColor({ color: "#0B2540" }); } } catch (e) {}
  try { var sp = cap.Plugins && cap.Plugins.SplashScreen; if (sp) sp.hide(); } catch (e) {}
})();
