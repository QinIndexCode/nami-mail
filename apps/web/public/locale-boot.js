// Apply the stored locale to the document language before React mounts, so
// the splash screen and initial paint honor the user's preference. The script
// is external because the desktop's local API CSP is `script-src 'self'`
// (inline scripts are blocked and hash pinning is fragile across builds).
// The desktop shell also gets `desktop-splash-instant` here: its native splash
// already shows the splash in the final state, so the web splash must not
// replay its entry animation on top of it — the two must hand over seamlessly.
try {
  var preferred = localStorage.getItem("nami-mail.locale-preference");
  if (preferred) document.documentElement.lang = preferred;
} catch (error) {
  // A blocked or unavailable storage layer must not stop the paint; the app
  // falls back to the default locale and Settings can still change it later.
}
try {
  if (new URLSearchParams(window.location.search).has("desktop")) {
    document.documentElement.classList.add("desktop-splash-instant");
  }
} catch (error) {
  // A blocked or unavailable storage layer must not stop the paint; the app
  // falls back to the default locale and Settings can still change it later.
}
