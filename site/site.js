/* Nami Mail site behaviour, shared by the landing page and the documentation.
 *
 * The pages are pre-rendered and the bilingual ones carry both languages in
 * their markup, so nothing here builds content. `theme-init.js` has already
 * applied the stored theme and language before the first paint; this file only
 * remembers the reader's choices from then on, and upgrades the landing page's
 * version label. Everything works without it: the language control on a
 * single-language page is a real link, and the markup holds both languages on a
 * bilingual one.
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var THEME_KEY = "nami-site-theme";
  var LANG_KEY = "nami-site-lang";
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
    meta.content = theme === "dark" ? "#050506" : "#ececef";
    document.head.appendChild(meta);

    var button = document.getElementById("theme-toggle");
    if (button) {
      button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }
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
    var labels = COPY_LABEL[lang] || COPY_LABEL.en;
    var buttons = document.querySelectorAll(".copy-button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute(
        "aria-label",
        buttons[i].classList.contains("is-copied") ? labels.done : labels.copy,
      );
    }
  }

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
        if (target) remember(LANG_KEY, target);
      });
    }
  }

  /* Restore the version shown on the landing page, and label every control that
   * depends on the language the page settled on. */
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

  /* Landing page only: show the version the release page actually offers. The
   * markup already states a version, so a failed or rate-limited request leaves
   * the page correct. */
  if (!document.getElementById("version-zh") || typeof fetch !== "function") return;
  fetch("https://api.github.com/repos/QinIndexCode/nami-mail/releases/latest", {
    headers: { accept: "application/vnd.github+json" },
  })
    .then(function (response) {
      return response.ok ? response.json() : null;
    })
    .then(function (release) {
      if (!release || !release.tag_name) return;
      var version = String(release.tag_name).replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+$/.test(version)) return;
      ["version-zh", "version-en", "version-download-zh", "version-download-en"].forEach(function (id) {
        var node = document.getElementById(id);
        if (node) node.textContent = version;
      });
    })
    .catch(function () {
      /* Keep the version written in the markup. */
    });
})();
