/* Categories page: every category as a folder, with its sub-categories inside. */
(function () {
  "use strict";
  var esc = SD.esc;
  SD.catalog().then(function (c) {
    var used = {};
    var html = "";
    Object.keys(SD.GROUPS).forEach(function (g) {
      var list = SD.GROUPS[g].filter(function (x) { return c.categories.indexOf(x) >= 0 || SD.FALLBACK_CATALOG[x]; });
      list.forEach(function (x) { used[x] = 1; });
      html += groupHtml(g, list, c.subs);
    });
    /* any category the server has that the groups do not know about */
    var extra = c.categories.filter(function (x) { return !used[x]; });
    if (extra.length) html += groupHtml("More", extra, c.subs);
    document.getElementById("groups").innerHTML = html;
  });

  function groupHtml(name, list, subs) {
    var n = 0;
    return '<div class="group-title"><h2>' + esc(name) + '</h2><span class="hand">' + list.length + " folders</span></div>" +
      '<div class="folders bigs">' + list.map(function (cat) {
        n++;
        var items = (subs[cat] || SD.FALLBACK_CATALOG[cat] || []).map(function (s) {
          return '<li><a href="search.html?category=' + encodeURIComponent(cat) + "&subcategory=" + encodeURIComponent(s) + '">' + esc(s) + "</a></li>";
        }).join("");
        return '<div class="folder big" data-n="' + String(n).padStart(2, "0") + '"><a class="ftitle" href="search.html?category=' + encodeURIComponent(cat) + '">' + esc(cat) + "</a><ul>" + items + "</ul></div>";
      }).join("") + "</div>";
  }
})();
