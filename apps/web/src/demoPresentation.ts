/** Presentation options for the public site's sample-data preview only. */
export type DemoPresentation = {
  locale: "zh-CN" | "en-US";
  theme: "light" | "dark";
  view: "mail" | "agent";
};

export function readDemoPresentation(search: string): DemoPresentation | null {
  const params = new URLSearchParams(search);
  if (params.get("demo") !== "1" || params.get("preview") !== "site") return null;
  return {
    locale: params.get("locale") === "en-US" ? "en-US" : "zh-CN",
    theme: params.get("theme") === "light" ? "light" : "dark",
    view: params.get("view") === "agent" ? "agent" : "mail",
  };
}

/** Let the embedding page reveal a settled demo rather than its startup splash. */
export function announceDemoReady(presentation: DemoPresentation): () => void {
  if (window.parent === window) return () => undefined;
  const notify = () => {
    const splash = document.getElementById("nami-splash");
    if (splash && !splash.classList.contains("done")) return;
    observer.disconnect();
    window.parent.postMessage({ type: "nami:demo-ready", ...presentation }, window.location.origin);
  };
  const observer = new MutationObserver(notify);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  notify();
  return () => observer.disconnect();
}
