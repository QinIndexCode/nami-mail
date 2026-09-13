/* Documentation page behaviour.
 *
 * Deliberately tiny and dependency-free. The pages are pre-rendered: the
 * navigation, the outline and the pager are plain HTML, so this file only adds
 * three conveniences on top — remembering the theme, remembering the language a
 * reader switched to, and collapsing the document list on narrow viewports. */
(function () {
  "use strict";

  var root = document.documentElement;

  function remember(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      /* A blocked storage layer must not break navigation. */
    }
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    var button = document.getElementById("theme-toggle");
    if (button) {
      button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }
  }

  var themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      remember("nami-site-theme", next);
    });
  }

  /* The language control is a real link to the same document in the other
   * language, so it works without scripting. This only records the choice. */
  var languageLink = document.getElementById("lang-toggle");
  if (languageLink) {
    languageLink.addEventListener("click", function () {
      var target = languageLink.getAttribute("data-lang-switch");
      if (target) remember("nami-site-lang", target);
    });
  }

  /* Below the three-column breakpoint the whole document tree would push the
   * article off the first screen, so collapse it. Without scripting the list
   * stays open and the reader can collapse it themselves. */
  var nav = document.querySelector(".docs-nav");
  if (nav && window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
    nav.removeAttribute("open");
  }

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
