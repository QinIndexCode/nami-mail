(function () {
  "use strict";

  var I18N = {
    zh: {
      nav_features: "功能", nav_agent: "Agent", nav_privacy: "隐私", nav_docs: "文档",
      search_ph: "搜索全部文档…",
      home_title: "Nami Mail 文档",
      home_sub: "按主题组织的使用指南、Agent、MCP、CLI、RAG 与开发文档。使用左侧搜索框检索全部内容。",
      home_hint: "提示：输入关键词即可在全部文档中检索，支持中英文。",
      home_docs: "篇文档",
      breadcrumb_home: "文档",
      notfound_title: "文档不存在",
      notfound_text: "该页面可能已被移动或删除，请通过左侧目录或搜索找到它。",
      toc_title: "本页目录",
      edit_page: "在 GitHub 上编辑此页",
      prev: "上一篇", next: "下一篇",
      count_docs: "篇文档",
      synced: "同步于",
      search_no: "未找到匹配的文档",
      search_hint: "输入关键词开始检索",
      manifest_fail: "无法加载文档索引。文档站需要先构建（运行 node scripts/sync-docs.mjs）。"
    },
    en: {
      nav_features: "Features", nav_agent: "Agent", nav_privacy: "Privacy", nav_docs: "Docs",
      search_ph: "Search all docs…",
      home_title: "Nami Mail Documentation",
      home_sub: "Organized guides for installation, Agent, MCP, CLI, RAG and development. Use the search box to look through everything.",
      home_hint: "Tip: type a keyword to search across every document, in Chinese or English.",
      home_docs: "documents",
      breadcrumb_home: "Docs",
      notfound_title: "Document not found",
      notfound_text: "This page may have moved or been removed. Use the tree or search to find it.",
      toc_title: "On this page",
      edit_page: "Edit this page on GitHub",
      prev: "Previous", next: "Next",
      count_docs: "documents",
      synced: "Synced",
      search_no: "No matching documents",
      search_hint: "Type a keyword to search",
      manifest_fail: "Unable to load the documentation index. Build the docs site first (run node scripts/sync-docs.mjs)."
    }
  };

  var GITHUB_BLOB = "https://github.com/QinIndexCode/nami-mail/blob/HEAD/docs/";
  var lang = "zh";
  var saved = null;
  try { saved = localStorage.getItem("nami-site-lang"); } catch (e) { /* ignore */ }
  lang = (saved === "en" || saved === "zh") ? saved : (navigator.language || "zh").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";

  var manifest = null;
  var flatItems = [];
  var docCache = {};
  var current = null;
  var preloaded = false;

  function t(key) {
    var d = I18N[lang] || I18N.zh;
    return d[key] !== undefined ? d[key] : key;
  }
  function tl(obj) {
    return obj && obj[lang] ? obj[lang] : (obj && obj.zh ? obj.zh : "");
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function slugify(text) {
    return "h-" + encodeURIComponent(String(text).toLowerCase().replace(/\s+/g, "-")).slice(0, 90);
  }
  function resolveRel(fromFile, rel) {
    var dir = fromFile.indexOf("/") >= 0 ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    var parts = dir ? dir.split("/") : [];
    var over = 0;
    rel.split("/").forEach(function (seg) {
      if (!seg || seg === ".") return;
      if (seg === "..") { if (parts.length) parts.pop(); else over++; }
      else parts.push(seg);
    });
    var path = parts.join("/");
    if (over > 0) path = "_root/" + path;
    return path;
  }
  function topicFor(path) {
    for (var i = 0; i < flatItems.length; i++) {
      var it = flatItems[i];
      if (it.files.zh === path || it.files.en === path) return it;
    }
    return null;
  }
  function findTopic(id) {
    for (var i = 0; i < flatItems.length; i++) if (flatItems[i].id === id) return flatItems[i];
    return null;
  }
  function groupLabel(groupId) {
    var g = manifest && manifest.groups.find(function (x) { return x.id === groupId; });
    return g ? g.label : null;
  }

  function $(id) { return document.getElementById(id); }
  var mdEl = $("md"), crumbEl = $("crumb"), treeEl = $("tree"), footEl = $("md-foot"),
      ptocEl = $("ptoc"), panelEl = $("search-panel"), qEl = $("q");

  if (window.marked && window.marked.use) {
    marked.use({ gfm: true, breaks: false });
  }

  /* ---------- routing ---------- */
  function parseHash() {
    var h = location.hash || "";
    var m = /^#\/([^#]*)(?:#(.+))?$/.exec(h);
    if (!m) return null;
    var topic = "", anchor = null;
    try { topic = decodeURIComponent(m[1]); } catch (e) { topic = m[1]; }
    if (m[2]) { try { anchor = decodeURIComponent(m[2]); } catch (e) { anchor = m[2]; } }
    return { topic: topic, anchor: anchor };
  }
  function go(topic, anchor) {
    var h = "#/" + encodeURIComponent(topic);
    if (anchor) h += "#" + encodeURIComponent(anchor);
    if (location.hash === h) return;
    location.hash = h;
  }

  /* ---------- sidebar ---------- */
  function groupIcon(id) {
    var icons = {
      guide: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 10h8"/><path d="M8 14h5"/>',
      agent: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>',
      rag: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M8 11h6"/>',
      mcp: '<path d="M9 2h6a1 1 0 0 1 1 1v1h3a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3V3a1 1 0 0 1 1-1z"/>',
      cli: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
      development: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
      releases: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
      root: '<path d="M12 2l8 5v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z"/>',
      misc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
    };
    return icons[id] || icons.misc;
  }
  function renderTree(activeId) {
    treeEl.innerHTML = "";
    var openedGroup = null;
    if (activeId) {
      var cur = findTopic(activeId);
      if (cur) openedGroup = cur.group;
    }
    manifest.groups.forEach(function (g) {
      var details = document.createElement("details");
      details.className = "tree-group";
      if (openedGroup === g.id) details.open = true;
      details.innerHTML =
        '<summary>' +
          '<svg class="g-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + groupIcon(g.id) + '</svg>' +
          '<span>' + esc(tl(g.label)) + '</span>' +
          '<span class="g-count">' + g.items.length + '</span>' +
          '<svg class="g-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</summary>' +
        '<div class="g-items"></div>';
      var itemsEl = details.querySelector(".g-items");
      g.items.forEach(function (it) {
        var a = document.createElement("a");
        a.className = "tree-link" + (it.id === activeId ? " on" : "");
        a.href = "#/" + encodeURIComponent(it.id);
        a.innerHTML = '<span class="t-dot"></span><span>' + esc(tl(it.title)) + '</span>';
        a.addEventListener("click", function () { maybeCloseSidebar(); });
        itemsEl.appendChild(a);
      });
      treeEl.appendChild(details);
    });
    var foot = $("sidebar-foot");
    if (foot) foot.textContent = flatItems.length + " " + t("count_docs") + " · " + t("synced") + " " + (manifest.generated || "");
  }

  /* ---------- rendering ---------- */
  function cleanLangSwitchLine(text) {
    return text.replace(/^\s*\[[^\]]+\]\([^)]*\.(?:zh-CN|en)\.md\)\s*\|\s*\[[^\]]+\]\([^)]*\.(?:zh-CN|en)\.md\)\s*$/gm, "");
  }
  function renderMD(text, file, anchor) {
    var html = "";
    try { html = marked.parse(cleanLangSwitchLine(text)); }
    catch (e) { html = "<p>Failed to render document.</p>"; }
    var root = document.createElement("div");
    root.innerHTML = html;

    root.querySelectorAll("a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (!href || /^[a-z]+:/i.test(href) || href.charAt(0) === "#" || href.charAt(0) === "/") return;
      var i = href.indexOf("#");
      var pathPart = i >= 0 ? href.slice(0, i) : href;
      var hashPart = i >= 0 ? href.slice(i + 1) : "";
      if (/\.md$/i.test(pathPart)) {
        var abs = resolveRel(file, pathPart);
        var topic = topicFor(abs);
        if (topic) {
          a.setAttribute("href", "#/" + encodeURIComponent(topic.id) + (hashPart ? "#" + encodeURIComponent(hashPart) : ""));
        } else {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener");
          a.setAttribute("href", GITHUB_BLOB + abs);
        }
      } else if (pathPart) {
        a.setAttribute("href", "docs/" + resolveRel(file, pathPart));
      }
    });

    root.querySelectorAll("img").forEach(function (img) {
      var src = img.getAttribute("src") || "";
      if (!src || /^[a-z]+:/i.test(src) || src.charAt(0) === "/") return;
      img.setAttribute("src", "docs/" + resolveRel(file, src));
      img.setAttribute("loading", "lazy");
    });

    root.querySelectorAll("h1, h2, h3, h4").forEach(function (h) {
      var id = slugify(h.textContent);
      h.setAttribute("id", id);
      h.classList.add("anchor-target");
    });

    mdEl.innerHTML = root.innerHTML;
    renderPageTOC();
    if (anchor) scrollToAnchor(anchor);
    else window.scrollTo(0, 0);
  }

  function renderPageTOC() {
    ptocEl.innerHTML = "";
    var heads = mdEl.querySelectorAll("h2, h3");
    if (heads.length < 2) return;
    var box = document.createElement("div");
    box.innerHTML = '<div class="pt-title">' + esc(t("toc_title")) + '</div>';
    heads.forEach(function (h) {
      var a = document.createElement("a");
      a.className = h.tagName === "H3" ? "lv3" : "lv2";
      a.href = "#" + h.id;
      a.textContent = h.textContent;
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        h.scrollIntoView({ behavior: "smooth", block: "start" });
        setTOCActive(a);
        if (current) {
          try { history.replaceState(null, "", location.pathname + location.search + "#/" + encodeURIComponent(current.id) + "#" + h.id); } catch (e) { /* ignore */ }
        }
      });
      box.appendChild(a);
    });
    ptocEl.appendChild(box);
  }
  function setTOCActive(el) {
    ptocEl.querySelectorAll("a.on").forEach(function (x) { x.classList.remove("on"); });
    if (el) el.classList.add("on");
  }
  function scrollToAnchor(anchor) {
    var el = document.getElementById(anchor);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setTOCActive(ptocEl.querySelector('a[href="#' + anchor + '"]'));
    }
  }

  /* ---------- loading ---------- */
  async function loadDoc(id, anchor) {
    var topic = findTopic(id);
    if (!topic) { renderNotFound(); return; }
    var file = topic.files[lang];
    var text = docCache[id];
    if (text === undefined) {
      try {
        var resp = await fetch("docs/" + file);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        text = await resp.text();
        docCache[id] = text;
      } catch (e) {
        renderNotFound();
        return;
      }
    }
    current = { id: topic.id, group: topic.group, file: file, title: tl(topic.title) };
    var gLabel = groupLabel(topic.group);
    crumbEl.innerHTML = '<a href="#/">' + esc(t("breadcrumb_home")) + '</a><span>/</span>' +
      (gLabel ? '<span>' + esc(tl(gLabel)) + '</span><span>/</span>' : "") +
      '<span>' + esc(tl(topic.title)) + '</span>';
    renderTree(topic.id);
    document.title = tl(topic.title) + " · Nami Mail";
    renderMD(text, file, anchor);
    renderFoot(topic);
  }

  function renderNotFound() {
    current = null;
    crumbEl.innerHTML = "";
    mdEl.innerHTML = '<div class="notfound"><h2>' + esc(t("notfound_title")) + '</h2><p>' + esc(t("notfound_text")) + '</p></div>';
    ptocEl.innerHTML = "";
    footEl.innerHTML = "";
    renderTree(null);
  }

  function renderFoot(topic) {
    var idx = flatItems.findIndex(function (f) { return f.id === topic.id; });
    var prev = idx > 0 ? flatItems[idx - 1] : null;
    var next = idx >= 0 && idx < flatItems.length - 1 ? flatItems[idx + 1] : null;
    footEl.innerHTML =
      '<div class="edit"><a href="' + GITHUB_BLOB + topic.file + '" target="_blank" rel="noopener">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>' +
        '<span>' + esc(t("edit_page")) + '</span></a></div>' +
      '<div class="pager">' +
        '<button type="button" data-nav="prev"' + (prev ? "" : " disabled") + '>' + esc(t("prev")) + (prev ? "：<b>" + esc(tl(prev.title)) + "</b>" : "") + '</button>' +
        '<button type="button" data-nav="next"' + (next ? "" : " disabled") + '>' + esc(t("next")) + (next ? "：<b>" + esc(tl(next.title)) + "</b>" : "") + '</button>' +
      '</div>';
    var pb = footEl.querySelector('[data-nav="prev"]');
    var nb = footEl.querySelector('[data-nav="next"]');
    if (pb) pb.addEventListener("click", function () { if (prev) go(prev.id); });
    if (nb) nb.addEventListener("click", function () { if (next) go(next.id); });
  }

  /* ---------- home ---------- */
  function renderHome() {
    current = null;
    renderTree(null);
    crumbEl.innerHTML = '<span>' + esc(t("breadcrumb_home")) + '</span>';
    document.title = "Nami Mail Documentation";
    var cards = manifest.groups.map(function (g) {
      var first = g.items[0];
      return '<a class="home-group" href="#/' + encodeURIComponent(first.id) + '">' +
        '<div class="hg-top"><span class="hg-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + groupIcon(g.id) + '</svg></span><h3>' + esc(tl(g.label)) + '</h3></div>' +
        '<p>' + esc(tl(first.title)) + ' · ' + g.items.length + ' ' + esc(t("home_docs")) + '</p>' +
      '</a>';
    }).join("");
    mdEl.innerHTML =
      '<div class="home"><div class="hh">' + esc(t("home_title")) + '</div>' +
      '<p class="hs">' + esc(t("home_sub")) + '</p>' +
      '<div class="home-groups">' + cards + '</div>' +
      '<div class="home-hint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>' + esc(t("home_hint")) + '</span></div>' +
      '</div>';
    ptocEl.innerHTML = "";
    footEl.innerHTML = "";
    window.scrollTo(0, 0);
  }

  /* ---------- language ---------- */
  function applyLangUI() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (I18N[lang][key] !== undefined) el.textContent = I18N[lang][key];
    });
    document.querySelectorAll("[data-lang-btn]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-lang-btn") === lang);
    });
    if (qEl) qEl.placeholder = t("search_ph");
  }
  function switchLang(next) {
    if (next === lang) return;
    lang = next;
    try { localStorage.setItem("nami-site-lang", lang); } catch (e) { /* ignore */ }
    applyLangUI();
    docCache = {};
    var r = parseHash();
    if (r && r.topic) loadDoc(r.topic, r.anchor);
    else renderHome();
  }

  /* ---------- search ---------- */
  function preloadAll() {
    if (preloaded) return;
    preloaded = true;
    var items = flatItems.slice();
    var i = 0;
    function worker() {
      while (i < items.length) {
        var it = items[i++];
        if (docCache[it.id] !== undefined) continue;
        return fetch("docs/" + it.files[lang])
          .then(function (r) { return r.ok ? r.text() : null; })
          .then(function (txt) { if (txt !== null) docCache[it.id] = txt; })
          .then(worker);
      }
    }
    for (var w = 0; w < 6; w++) worker();
  }
  function makeSnippet(text, ql, idx) {
    var start = Math.max(0, idx - 40);
    var end = Math.min(text.length, idx + ql.length + 100);
    var s = text.slice(start, end).replace(/\s+/g, " ").trim();
    return (start > 0 ? "…" : "") + s + (end < text.length ? "…" : "");
  }
  function search(q) {
    var ql = q.toLowerCase().trim();
    var out = [];
    flatItems.forEach(function (it) {
      var text = docCache[it.id] || "";
      var title = tl(it.title) || "";
      var ti = title.toLowerCase().indexOf(ql);
      var bi = text.toLowerCase().indexOf(ql);
      if (ti >= 0 || bi >= 0) {
        out.push({ it: it, score: ti >= 0 ? (bi >= 0 ? 0 : 1) : 2, snippet: bi >= 0 ? makeSnippet(text, ql, bi) : title });
      }
    });
    out.sort(function (a, b) { return a.score - b.score; });
    return out.slice(0, 20);
  }
  function mark(text, ql) {
    var s = esc(text);
    var idx = s.toLowerCase().indexOf(ql.toLowerCase());
    if (idx < 0) return s;
    var end = idx + ql.length;
    return s.slice(0, idx) + "<mark>" + s.slice(idx, end) + "</mark>" + s.slice(end);
  }
  function openSearch() {
    panelEl.innerHTML = "";
    panelEl.classList.add("open");
    var ql = qEl.value.trim().toLowerCase();
    if (!ql) { panelEl.innerHTML = '<div class="search-empty">' + esc(t("search_hint")) + '</div>'; return; }
    var results = search(ql);
    if (!results.length) { panelEl.innerHTML = '<div class="search-empty">' + esc(t("search_no")) + '</div>'; return; }
    results.forEach(function (r) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item";
      btn.innerHTML = '<div class="si-title">' + mark(tl(r.it.title), ql) + '</div><div class="si-snip">' + mark(r.snippet, ql) + '</div>';
      btn.addEventListener("click", function () {
        go(r.it.id);
        panelEl.classList.remove("open");
        qEl.blur();
      });
      panelEl.appendChild(btn);
    });
  }
  function closeSearch() { panelEl.classList.remove("open"); }

  /* ---------- misc ---------- */
  function rebuildFlat() {
    flatItems = [];
    manifest.groups.forEach(function (g) {
      g.items.forEach(function (it) {
        flatItems.push({ group: g.id, id: it.id, title: it.title, files: it.files });
      });
    });
  }
  function maybeCloseSidebar() {
    if (window.innerWidth <= 760) {
      var sb = document.querySelector(".sidebar");
      if (sb && sb.style.display !== "none") sb.style.display = "none";
    }
  }

  /* ---------- init ---------- */
  async function init() {
    applyLangUI();
    var nav = document.getElementById("nav");
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    document.querySelectorAll("[data-lang-btn]").forEach(function (btn) {
      btn.addEventListener("click", function () { switchLang(btn.getAttribute("data-lang-btn")); });
    });

    var debounce = null;
    qEl.addEventListener("input", function () {
      clearTimeout(debounce);
      if (!preloaded) preloadAll();
      debounce = setTimeout(openSearch, 140);
    });
    qEl.addEventListener("focus", function () { openSearch(); });
    qEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { closeSearch(); qEl.blur(); }
      if (ev.key === "Enter") { var on = panelEl.querySelector(".search-item"); if (on) on.click(); }
    });
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest(".search-box")) closeSearch();
    });

    window.addEventListener("hashchange", function () {
      var h = parseHash();
      if (!h || !h.topic) { renderHome(); return; }
      if (current && current.id === h.topic) {
        if (h.anchor) scrollToAnchor(h.anchor);
        else window.scrollTo(0, 0);
        return;
      }
      loadDoc(h.topic, h.anchor);
    });

    var spyTimer = null;
    window.addEventListener("scroll", function () {
      if (!current || ptocEl.querySelectorAll("a").length === 0) return;
      if (spyTimer) return;
      spyTimer = setTimeout(function () {
        spyTimer = null;
        var h2s = mdEl.querySelectorAll("h2, h3");
        var pos = window.scrollY + 130;
        var active = null;
        h2s.forEach(function (h) {
          if (h.offsetTop <= pos) active = h;
        });
        if (active) setTOCActive(ptocEl.querySelector('a[href="#' + active.id + '"]'));
      }, 80);
    }, { passive: true });

    try {
      var resp = await fetch("docs/docs-manifest.json", { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      manifest = await resp.json();
    } catch (e) {
      mdEl.innerHTML = '<div class="notfound"><h2>manifest.json</h2><p>' + esc(t("manifest_fail")) + '</p></div>';
      return;
    }
    rebuildFlat();

    var r = parseHash();
    if (r && r.topic) await loadDoc(r.topic, r.anchor);
    else renderHome();

    var idle = window.requestIdleCallback || function (cb) { setTimeout(cb, 500); };
    idle(function () { preloadAll(); });
  }

  init();
})();
