/* Nami Mail site behaviour, shared by the landing page and the documentation.
 *
 * The pages are pre-rendered and the bilingual ones carry both languages in
 * their markup, so nothing here builds content. `theme-init.js` has already
 * applied the stored theme and language before the first paint; this file only
 * remembers the reader's choices and loads the shared client's sample preview.
 * The content stays readable without it: the language control on a
 * single-language page is a real link, and the markup holds both languages on a
 * bilingual one.
 */
(function () {
  "use strict";

  var root = document.documentElement;
  root.dataset.scripted = "true";
  var THEME_KEY = "nami-site-theme";
  var LANG_KEY = "nami-site-lang";
  var demoFrames = document.querySelectorAll("iframe[data-demo]");
  var demoTimers = new WeakMap();
  /* The copy button is an icon, but a screen reader still needs words. */
  var COPY_LABEL = {
    zh: { copy: "复制代码", done: "已复制" },
    en: { copy: "Copy code", done: "Copied" },
  };

  function remember(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* A blocked storage layer must not break navigation. */
    }
  }

  /* The two `theme-color` metas in the markup follow the operating system, which
   * is wrong as soon as a theme is applied here — the browser chrome would stay
   * light behind a dark page. Collapse them into the colour actually in use. */
  function applyTheme(theme) {
    root.dataset.theme = theme;
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].remove();
    var meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = theme === "dark" ? "#0c0d10" : "#f4f5f8";
    document.head.appendChild(meta);

    var button = document.getElementById("theme-toggle");
    if (button) {
      var isZh = root.dataset.lang !== "en";
      var label = theme === "dark" ? (isZh ? "切换为浅色主题" : "Switch to light theme") : (isZh ? "切换为深色主题" : "Switch to dark theme");
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    syncDemos();
  }

  /* A bilingual page states both titles on <html>, because the document title is
   * the one piece of content CSS cannot switch. Pages whose title reads the same
   * in both languages leave the attributes off. */
  function applyLanguage(lang) {
    root.dataset.lang = lang;
    root.lang = lang === "zh" ? "zh-CN" : "en";
    var zh = root.dataset.titleZh;
    var en = root.dataset.titleEn;
    if (zh && en) document.title = lang === "zh" ? zh : en;
    var description = lang === "zh" ? root.dataset.descriptionZh : root.dataset.descriptionEn;
    if (description) {
      setMeta('meta[name="description"]', description);
      setMeta('meta[property="og:title"]', document.title);
      setMeta('meta[property="og:description"]', description);
      setMeta('meta[name="twitter:title"]', document.title);
      setMeta('meta[name="twitter:description"]', description);
      setMeta('meta[property="og:locale"]', lang === "zh" ? "zh_CN" : "en_US");
      setMeta('meta[property="og:locale:alternate"]', lang === "zh" ? "en_US" : "zh_CN");
      var image = "https://qinindexcode.github.io/nami-mail/assets/nami-mail-inbox-" + (lang === "zh" ? "zh" : "en") + ".png";
      var alt = lang === "zh" ? "Nami Mail 多账户收件箱界面" : "Nami Mail multi-account inbox";
      setMeta('meta[property="og:image"]', image);
      setMeta('meta[name="twitter:image"]', image);
      setMeta('meta[property="og:image:alt"]', alt);
      setMeta('meta[name="twitter:image:alt"]', alt);
    }
    var languageButton = document.getElementById("lang-toggle");
    if (languageButton && languageButton.tagName === "BUTTON") {
      languageButton.setAttribute("aria-label", lang === "zh" ? "切换到英文" : "Switch to Chinese");
    }
    var mainNavigation = document.querySelector(".site-nav");
    var mobileNavigationLabel = document.querySelector(".mobile-navigation nav");
    if (mainNavigation) mainNavigation.setAttribute("aria-label", lang === "zh" ? "主导航" : "Main");
    if (mobileNavigationLabel) mobileNavigationLabel.setAttribute("aria-label", lang === "zh" ? "移动导航" : "Mobile");
    var themeButton = document.getElementById("theme-toggle");
    if (themeButton) {
      var themeLabel = root.dataset.theme === "dark" ? (lang === "zh" ? "切换为浅色主题" : "Switch to light theme") : (lang === "zh" ? "切换为深色主题" : "Switch to dark theme");
      themeButton.setAttribute("aria-label", themeLabel);
      themeButton.title = themeLabel;
    }
    syncDemos();
    var labels = COPY_LABEL[lang] || COPY_LABEL.en;
    var buttons = document.querySelectorAll(".copy-button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute(
        "aria-label",
        buttons[i].classList.contains("is-copied") ? labels.done : labels.copy,
      );
    }
  }

  function setMeta(selector, content) {
    var meta = document.querySelector(selector);
    if (meta) meta.content = content;
  }

  function demoUrl(view) {
    return "./demo/?demo=1&preview=site&theme=" + (root.dataset.theme === "dark" ? "dark" : "light") +
      "&locale=" + (root.dataset.lang === "en" ? "en-US" : "zh-CN") + "&view=" + view;
  }

  function updateDemoState(frame, state) {
    var stage = frame.closest(".demo-stage");
    stage.dataset.state = state;
    stage.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    frame.hidden = state === "waiting" || state === "error";
    frame.setAttribute("aria-hidden", state === "ready" ? "false" : "true");
    stage.querySelector(".demo-placeholder").setAttribute("aria-hidden", state === "ready" ? "true" : "false");
    var isZh = root.dataset.lang !== "en";
    var loadingLabel = stage.querySelector("[data-loading-label]");
    loadingLabel.textContent = state === "error" ?
      (isZh ? "演示暂时未打开，可以重试。" : "The demo could not open. Try again.") :
      (isZh ? "正在准备演示…" : "Preparing the demo…");
    loadingLabel.classList.toggle("sr-only", state !== "error");
    var retryButton = stage.querySelector("[data-demo-retry]");
    retryButton.hidden = state !== "error";
    retryButton.disabled = state !== "error";
    retryButton.textContent = isZh ? "重试" : "Retry";
    var resetButton = document.querySelector('[data-demo-reset="' + frame.dataset.demo + '"]');
    if (resetButton) resetButton.hidden = state !== "ready";
  }

  function loadDemo(frame, reset) {
    var url = demoUrl(frame.dataset.demo);
    if (!reset && frame.getAttribute("src") === url) return;
    window.clearTimeout(demoTimers.get(frame));
    frame.dataset.started = "true";
    updateDemoState(frame, "loading");
    // The observer owns when loading starts; browser look-ahead must not run it early.
    frame.loading = "eager";
    frame.setAttribute("src", url);
    demoTimers.set(frame, window.setTimeout(function () {
      updateDemoState(frame, "error");
    }, 25000));
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.origin !== window.location.origin || !data || data.type !== "nami:demo-ready") return;
    if (data.theme !== root.dataset.theme || data.locale !== (root.dataset.lang === "en" ? "en-US" : "zh-CN")) return;
    for (var i = 0; i < demoFrames.length; i++) {
      var frame = demoFrames[i];
      if (event.source !== frame.contentWindow || data.view !== frame.dataset.demo || !frame.dataset.started) continue;
      window.clearTimeout(demoTimers.get(frame));
      updateDemoState(frame, "ready");
    }
  });

  function syncDemos(resetView) {
    for (var i = 0; i < demoFrames.length; i++) {
      var frame = demoFrames[i];
      var view = frame.dataset.demo;
      var url = demoUrl(view);
      frame.title = root.dataset.lang === "en" ?
        (view === "agent" ? "Interactive Nami Mail assistant demo" : "Interactive Nami Mail inbox demo") :
        (view === "agent" ? "可交互的 Nami Mail 邮件助理演示" : "可交互的 Nami Mail 收件箱演示");
      if (frame.dataset.started && (frame.getAttribute("src") !== url || resetView === view)) loadDemo(frame, resetView === view);
      else updateDemoState(frame, frame.closest(".demo-stage").dataset.state);
    }
    var links = document.querySelectorAll("[data-demo-open]");
    for (var j = 0; j < links.length; j++) links[j].setAttribute("href", demoUrl(links[j].dataset.demoOpen));
  }

  var resetButtons = document.querySelectorAll("[data-demo-reset]");
  for (var resetIndex = 0; resetIndex < resetButtons.length; resetIndex++) {
    resetButtons[resetIndex].addEventListener("click", function (event) {
      syncDemos(event.currentTarget.dataset.demoReset);
    });
  }

  var mobileNavigation = document.querySelector(".mobile-navigation");
  if (mobileNavigation) {
    mobileNavigation.addEventListener("click", function (event) {
      if (event.target instanceof Element && event.target.closest("a")) mobileNavigation.open = false;
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !mobileNavigation.open) return;
      mobileNavigation.open = false;
      mobileNavigation.querySelector("summary").focus();
    });
    document.addEventListener("click", function (event) {
      if (mobileNavigation.open && !mobileNavigation.contains(event.target)) mobileNavigation.open = false;
    });
  }

  function updateNavigation() {
    var sections = { "#features": "features", "#agent": "agent", "#privacy": "privacy" };
    var active = document.body.classList.contains("docs-body") ? "docs" : (sections[window.location.hash] || "home");
    var links = document.querySelectorAll(".site-header a[data-nav]");
    for (var i = 0; i < links.length; i++) {
      if (links[i].dataset.nav === active) {
        links[i].setAttribute("aria-current", active === "home" || active === "docs" ? "page" : "location");
      } else {
        links[i].removeAttribute("aria-current");
      }
    }
  }
  updateNavigation();
  window.addEventListener("hashchange", updateNavigation);

  var header = document.querySelector(".site-header");
  if (header) header.addEventListener("click", function (event) {
    var link = event.target instanceof Element ? event.target.closest("a") : null;
    if (link && link.id !== "lang-toggle" && new URL(link.href).origin === window.location.origin) {
      remember(LANG_KEY, root.dataset.lang === "en" ? "en" : "zh");
    }
  });

  /* Below the three-column breakpoint the whole document tree would push the
   * article off the first screen, so collapse it. Without scripting the list
   * stays open and the reader can collapse it themselves. */
  var nav = document.querySelector(".docs-nav");
  if (nav && window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
    nav.removeAttribute("open");
  }

  var themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      remember(THEME_KEY, next);
    });
  }

  /* Two shapes, one id: a button on pages that carry both languages, and a real
   * link to the same document in the other language on pages that carry one.
   * The link works with scripting disabled, so this only records the choice. */
  var languageToggle = document.getElementById("lang-toggle");
  if (languageToggle) {
    if (languageToggle.tagName === "BUTTON") {
      languageToggle.addEventListener("click", function () {
        var next = root.dataset.lang === "zh" ? "en" : "zh";
        applyLanguage(next);
        remember(LANG_KEY, next);
      });
    } else {
      languageToggle.addEventListener("click", function () {
        var target = languageToggle.getAttribute("data-lang-switch");
        if (target) remember(LANG_KEY, target.indexOf("zh") === 0 ? "zh" : "en");
      });
    }
  }

  /* Keep the footer's year current without a remote request. */
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /**
   * Add a copy button to every code block on the page. The button is created
   * here rather than in the markup so that it cannot appear — or sit there doing
   * nothing — with scripting disabled, and so the documentation pages get it for
   * free from the build.
   */
  var COPY_ICON =
    '<svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15" stroke-linecap="round"/></svg>' +
    '<svg class="copy-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="m5 12.5 4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("clipboard unavailable"));
  }

  function initCopyButtons() {
    var blocks = document.querySelectorAll("pre");
    for (var i = 0; i < blocks.length; i++) {
      (function (block) {
        var code = block.querySelector("code");
        if (!code || block.querySelector(".copy-button")) return;
        var button = document.createElement("button");
        button.type = "button";
        button.className = "copy-button";
        button.innerHTML = COPY_ICON;
        button.addEventListener("click", function () {
          copyText(code.textContent).then(
            function () {
              button.classList.add("is-copied");
              applyLanguage(root.dataset.lang === "en" ? "en" : "zh");
              window.setTimeout(function () {
                button.classList.remove("is-copied");
                applyLanguage(root.dataset.lang === "en" ? "en" : "zh");
              }, 1600);
            },
            function () {
              /* Nothing to restore: the reader can still select the text. */
            },
          );
        });
        block.appendChild(button);
      })(blocks[i]);
    }
  }

  initCopyButtons();

  /* Settle the labels that depend on the language the page ended up in — the
   * stored preference or the browser's, applied by `theme-init.js`. */
  applyTheme(root.dataset.theme === "dark" ? "dark" : "light");
  applyLanguage(root.dataset.lang === "en" ? "en" : "zh");

  // Tours operate the same offline client controls. Documentation pages have no
  // frames and need neither the controller nor its observers.
  if (demoFrames.length) {
    import("./demo-tour.js").then(function (module) {
      module.initDemoTours(demoFrames);
    }).catch(function () {
      // A failed optional tour must leave the manual demo usable.
    });
  }

  // Reserve the final height, then start each demo once its main surface is in view.
  // Let scrolling settle so a smooth anchor jump does not start demos it passes.
  // Older browsers use the same visibility gate without a manual start button.
  var visibleDemos = new Set();
  var demoStartTimer;
  function scheduleVisibleDemos() {
    window.clearTimeout(demoStartTimer);
    if (!visibleDemos.size) return;
    demoStartTimer = window.setTimeout(function () {
      visibleDemos.forEach(function (stage) {
        loadDemo(stage.querySelector("iframe[data-demo]"), false);
        if (demoObserver) demoObserver.unobserve(stage);
      });
      visibleDemos.clear();
    }, 150);
  }
  var demoObserver = demoFrames.length && typeof IntersectionObserver === "function" ? new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting && entries[i].intersectionRatio >= 0.25) visibleDemos.add(entries[i].target);
      else visibleDemos.delete(entries[i].target);
    }
    scheduleVisibleDemos();
  }, { threshold: 0.25, rootMargin: "-64px 0px 0px 0px" }) : null;
  function scanVisibleDemos() {
    for (var i = 0; i < demoFrames.length; i++) {
      if (demoFrames[i].dataset.started) continue;
      var stage = demoFrames[i].closest(".demo-stage");
      var rect = stage.getBoundingClientRect();
      var width = Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left));
      var height = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(64, rect.top));
      if (rect.width * rect.height > 0 && width * height / (rect.width * rect.height) >= 0.25) visibleDemos.add(stage);
      else visibleDemos.delete(stage);
    }
    scheduleVisibleDemos();
  }
  if (demoObserver) window.addEventListener("scroll", scheduleVisibleDemos, { passive: true });
  for (var demoIndex = 0; demoIndex < demoFrames.length; demoIndex++) {
    var stage = demoFrames[demoIndex].closest(".demo-stage");
    if (demoObserver) demoObserver.observe(stage);
    stage.querySelector("[data-demo-retry]").addEventListener("click", function (event) {
      var stage = event.currentTarget.closest(".demo-stage");
      visibleDemos.delete(stage);
      loadDemo(stage.querySelector("iframe[data-demo]"), true);
      if (demoObserver) demoObserver.unobserve(stage);
    });
  }
  if (!demoObserver && demoFrames.length) {
    window.addEventListener("scroll", scanVisibleDemos, { passive: true });
    window.addEventListener("resize", scanVisibleDemos);
    scanVisibleDemos();
  }

})();
