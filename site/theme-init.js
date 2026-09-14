/* Applies the stored theme — and, on bilingual pages, the stored language —
 * before the first paint, so the page never flashes the wrong one.
 *
 * Loaded without `defer` on purpose: it has to run before the body is rendered.
 * It is a few hundred bytes and cached across the whole site, which is cheaper
 * than inlining a copy into every generated page.
 *
 * The markup already carries usable defaults (`data-theme="light"`,
 * `data-lang="zh"`), so a reader with scripting disabled still gets a correct
 * page — just not their stored preference. */
(function () {
  "use strict";

  var root = document.documentElement;

  try {
    var storedTheme = localStorage.getItem("nami-site-theme");
    if (storedTheme === "dark" || storedTheme === "light") {
      root.dataset.theme = storedTheme;
    } else {
      root.dataset.theme =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {
    /* A blocked storage layer must not break the page. */
  }

  /* Only pages that carry both languages in their markup get the language
   * switch; single-language pages bake theirs into the markup. */
  if (!root.hasAttribute("data-bilingual")) return;

  try {
    var storedLang = localStorage.getItem("nami-site-lang");
    if (storedLang !== "zh" && storedLang !== "en") {
      storedLang = (navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
    }
    root.dataset.lang = storedLang;
    root.lang = storedLang === "zh" ? "zh-CN" : "en";
  } catch {
    /* Keep the language written in the markup. */
  }
})();
