/* SupplyDesk smart search: understands plain-language needs ("machine to cut metal sheets") and ranks listings.
   Pure client-side, no external service. Data: window.SD_TAX (taxonomy.js). API: SmartSearch.rank(items, query). */
(function (g) {
  'use strict';
  var STOP = new Set(('a an the i we you me my our your for to of in on at with and or from by is are be am need needs needed want wants wanted looking look find get buy buying purchase require required requirement ' +
    'supplier suppliers manufacturer manufacturers manufacturing company companies vendor vendors wholesale wholesaler exporter exporters best good quality cheap price prices pricing rate quote quotation please ' +
    'any some something someone that this which can could would should like type kind used use using make made makes making sale sell selling item items product products near me us what where who how very much many more').split(' '));

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9À-ɏ\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function stem(w) {
    if (w.length <= 3) return w;
    if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
    if (/(ss|us|is)$/.test(w)) return w;
    if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
    if (/ing$/.test(w) && w.length > 5) { var b = w.slice(0, -3); if (/([^aeiou])\1$/.test(b)) b = b.slice(0, -1); return b; }
    if (/s$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function tokens(s, keepStop) { return norm(s).split(' ').filter(function (t) { return t && (keepStop || !STOP.has(t)); }).map(stem); }
  function lev(a, b, max) {
    if (a === b) return 0; if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j; for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i; var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        var c = a[i - 1] === b[j - 1] ? 0 : 1; cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], (prevprev[j - 2] || 0) + 1);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      var prevprev = prev; prev = cur; cur = [];
    }
    return prev[b.length];
  }

  /* ---- concept index built once from the taxonomy ---- */
  var IDX = null;
  function buildIndex() {
    var tax = g.SD_TAX || { subs: {}, aliases: {}, keywords: {} }, map = {}, phrases = [];
    function add(word, cat, sub, w) {
      if (!word || STOP.has(word)) return; var k = stem(word); (map[k] = map[k] || []).push({ cat: cat, sub: sub || '', w: w });
    }
    Object.keys(tax.subs || {}).forEach(function (cat) {
      tokens(cat).forEach(function (t) { add(t, cat, '', 2); });
      (tax.subs[cat] || []).forEach(function (sub) { if (sub !== 'Other') tokens(sub).forEach(function (t) { add(t, cat, sub, 3); }); });
    });
    Object.keys(tax.keywords || {}).forEach(function (key) {
      var p = key.split('/'), w = p[1] ? 2 : 1;
      tokens(tax.keywords[key]).forEach(function (t) { add(t, p[0], p[1] || '', w); });
    });
    Object.keys(tax.aliases || {}).forEach(function (a) {
      var v = tax.aliases[a];
      if (a.indexOf(' ') > -1) phrases.push({ phrase: norm(a), cat: v[0], sub: v[1] || '' });
      else add(a, v[0], v[1] || '', 5);
    });
    return { map: map, phrases: phrases };
  }

  function understand(query) {
    if (!IDX) IDX = buildIndex();
    var q = ' ' + norm(query) + ' ', score = {}, label = {};
    function hit(cat, sub, w) {
      var k = cat + '|' + sub; score[k] = (score[k] || 0) + w; label[k] = { cat: cat, sub: sub };
      if (sub) { var kc = cat + '|'; score[kc] = (score[kc] || 0) + w * 0.6; label[kc] = { cat: cat, sub: '' }; }
    }
    IDX.phrases.forEach(function (p) { if (q.indexOf(' ' + p.phrase + ' ') > -1) hit(p.cat, p.sub, 6); });
    tokens(query).forEach(function (t) { (IDX.map[t] || []).forEach(function (e) { hit(e.cat, e.sub, e.w); }); });
    var list = Object.keys(score).map(function (k) { return { cat: label[k].cat, sub: label[k].sub, score: score[k] }; });
    list.sort(function (a, b) { return b.score - a.score || (b.sub ? 1 : 0) - (a.sub ? 1 : 0); });
    return list;
  }

  var W = { name: 6, sub: 5, cat: 4, tag: 3, desc: 2, sup: 2.2, loc: 1.5 };

  function rank(items, query, opts) {
    opts = opts || {};
    var qt = tokens(query);
    var concepts = understand(query);
    var top = concepts.length ? concepts[0].score : 0;
    var conceptMap = {}; concepts.forEach(function (c) { if (c.score >= top * 0.35) conceptMap[c.cat + '|' + c.sub] = c.score; });

    // location words = any query token equal to a country/city present in the data
    var locSet = {}; items.forEach(function (it) { tokens(it.country).concat(tokens(it.city)).forEach(function (t) { locSet[t] = 1; }); });
    var contentTokens = qt.filter(function (t) { return !locSet[t]; });
    var onlyLocation = qt.length > 0 && contentTokens.length === 0;

    var out = [];
    items.forEach(function (it) {
      var f = {
        name: tokens(it.name, true), sub: tokens((it.subcategories || []).join(' '), true), cat: tokens(it.category, true),
        tag: tokens((it.tags || []).join(' '), true), desc: tokens(it.desc, true), sup: tokens(it.supplierName, true), loc: tokens((it.country || '') + ' ' + (it.city || ''), true)
      };
      var s = 0, content = 0, matched = {}, covered = 0;
      qt.forEach(function (t) {
        var best = 0, bestField = '';
        Object.keys(f).forEach(function (k) {
          var arr = f[k], v = 0, i;
          if (arr.indexOf(t) > -1) v = W[k];
          else if (t.length >= 4) {
            for (i = 0; i < arr.length && v < W[k] * 0.7; i++) if (arr[i].length > t.length && arr[i].indexOf(t) === 0) v = W[k] * 0.7;
            if (!v && t.length >= 5) for (i = 0; i < arr.length; i++) { var d = lev(t, arr[i], t.length >= 8 ? 2 : 1); if (d <= (t.length >= 8 ? 2 : 1)) { v = W[k] * 0.6; break; } }
          }
          if (v > best) { best = v; bestField = k; }
        });
        if (best) { s += best; covered++; matched[t] = bestField; if (bestField !== 'loc') content += best; }
      });
      // concept boost: the listing belongs to what the buyer described
      var subs = (it.subcategories && it.subcategories.length) ? it.subcategories : [''], cBoost = 0, cLabel = null;
      subs.forEach(function (sb) {
        var a = conceptMap[(it.category || '') + '|' + sb] || 0, b = conceptMap[(it.category || '') + '|'] || 0;
        var v = a * 2.2 + b * 1.2; if (v > cBoost) { cBoost = v; cLabel = { cat: it.category, sub: a ? sb : '' }; }
      });
      s += cBoost; content += cBoost;
      if (qt.length > 1) s += (covered / qt.length) * 6;           // reward listings that cover more of what was asked
      if (!(onlyLocation ? s > 0 : content > 0)) return;
      out.push({ item: it, score: s, concept: cLabel, matched: Object.keys(matched) });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    if (out.length) { var cut = out[0].score * (opts.minRatio || 0.18); out = out.filter(function (r) { return r.score >= cut; }); }
    return { results: out, concepts: concepts.filter(function (c) { return c.score >= top * 0.5; }).slice(0, 4), tokens: qt, understood: concepts.length > 0 };
  }

  g.SmartSearch = { rank: rank, understand: understand, tokens: tokens, norm: norm };
})(window);
