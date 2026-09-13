/* Landing page behaviour.
 *
 * Deliberately tiny and dependency-free: the page renders and reads correctly
 * without it (CSS does the language hiding, the markup carries both languages,
 * and the download links point at /releases/latest). Everything here is an
 * enhancement on top of that. */

(function () {
  "use strict";

  var root = document.documentElement;
  var storage = {
    get: function (key) {
      try {
        return localStorage.getItem(key);
      } catch (error) {
        return null;
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (error) {
        /* A blocked storage layer must not break the page. */
      }
    },
  };

  var titles = {
    zh: "Nami Mail · 本地优先的桌面邮件客户端",
    en: "Nami Mail · Local-first desktop mail client",
  };

  function applyLanguage(lang) {
    root.dataset.lang = lang;
    root.lang = lang === "zh" ? "zh-CN" : "en";
    if (titles[lang]) document.title = titles[lang];
    var toggle = document.getElementById("lang-toggle");
    if (toggle) toggle.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切换到中文");
  }

  /* The brand mark has a light and a dark cut; swapping keeps the header legible
   * on both themes, which is what the two files exist for. */
  function applyTheme(theme) {
    root.dataset.theme = theme;
    var mark = document.querySelector(".brand img");
    if (mark) mark.src = theme === "dark" ? "./assets/brand/mark-dark.png" : "./assets/brand/mark-light.png";
    var button = document.getElementById("theme-toggle");
    if (button) button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }

  function initToggle(id, onActivate) {
    var button = document.getElementById(id);
    if (!button) return;
    button.addEventListener("click", onActivate);
  }

  initToggle("lang-toggle", function () {
    var next = root.dataset.lang === "zh" ? "en" : "zh";
    applyLanguage(next);
    storage.set("nami-site-lang", next);
  });

  initToggle("theme-toggle", function () {
    var next = root.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    storage.set("nami-site-theme", next);
  });

  /* Progressive enhancement: show the version the release page actually offers.
   * The markup already states a version, so a failed or rate-limited request
   * leaves the page correct. */
  function showVersion(tag) {
    var version = String(tag || "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) return;
    ["version-zh", "version-en", "version-download-zh", "version-download-en"].forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.textContent = version;
    });
  }

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  if (typeof fetch === "function") {
    fetch("https://api.github.com/repos/QinIndexCode/nami-mail/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (release) {
        if (release && release.tag_name) showVersion(release.tag_name);
      })
      .catch(function () {
        /* Keep the version written in the markup. */
      });
  }
})();
