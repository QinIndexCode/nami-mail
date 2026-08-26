// Vitest global setup. jsdom does not implement scrollIntoView; the Agent
// workspace's slash/mention menus scroll the selected option into view under
// requestAnimationFrame, which would otherwise throw on every environment
// where jsdom is the DOM (CI included).
// Pure-logic suites run in the plain node environment, where the DOM globals
// do not exist at all — only patch when an Element is actually available.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
