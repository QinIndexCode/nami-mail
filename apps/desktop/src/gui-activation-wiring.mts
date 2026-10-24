import type { App, BrowserWindow } from "electron";
import { extractMailtoUrl } from "./desktop-behaviors.mjs";
import { createGuiActivation, type GuiActivation } from "./gui-activation.mjs";

export type GuiActivationWiringPorts = {
  hasMainWindow: () => boolean;
  waitForBoot: () => Promise<void>;
  createMainWindow: () => Promise<void>;
  focusMainWindow: () => void;
  deliverCompose: (mailtoUrl: string) => void;
  onError: (error: unknown) => void;
  /** The argv mailto of this launch; queued once so a reload cannot replay it. */
  launchMailtoUrl?: string;
};

/**
 * The main process's binding of the pure activation coordinator to Electron.
 *
 * Two lifecycle facts are tracked here rather than in main.mts: one in-flight
 * app document load per window (shared by every caller, cleared on either
 * outcome), and the window's loading/finished milestones. The coordinator only
 * needs to know whether the current document can receive compose IPC, so the
 * wiring reports the app URL's did-finish-load and treats the splash and any
 * new navigation as not ready.
 */
export type GuiActivationWiring = GuiActivation & {
  /** Reports a document load and shares one in-flight load across callers. */
  loadAppDocument: (load: () => Promise<void>) => Promise<void>;
  /** Tracks the window's document readiness for compose IPC. */
  watchWindowDocument: (window: BrowserWindow, isAppUrl: (url: string) => boolean) => void;
};

export function createGuiActivationWiring(ports: GuiActivationWiringPorts): GuiActivationWiring {
  let appDocumentLoad: Promise<void> | undefined;
  const activation = createGuiActivation({
    hasMainWindow: ports.hasMainWindow,
    waitForBoot: ports.waitForBoot,
    waitForAppDocument: () => appDocumentLoad ?? Promise.resolve(),
    createMainWindow: ports.createMainWindow,
    focusMainWindow: ports.focusMainWindow,
    deliverCompose: ports.deliverCompose,
    onError: ports.onError,
  });
  // This queued request belongs to the launch itself, not to a particular
  // document: a service restart may reload the app but must not replay it.
  if (ports.launchMailtoUrl) activation.queueMailto(ports.launchMailtoUrl);
  return {
    ...activation,
    loadAppDocument(load) {
      if (appDocumentLoad) return appDocumentLoad;
      activation.notifyLoading();
      const tracked = load();
      appDocumentLoad = tracked;
      // Both outcomes clear the marker; the load's own rejection still reaches
      // its original caller.
      const clear = (): void => {
        if (appDocumentLoad === tracked) appDocumentLoad = undefined;
      };
      void tracked.then(clear, clear);
      return tracked;
    },
    watchWindowDocument(window, isAppUrl) {
      window.webContents.on("did-start-loading", () => activation.notifyLoading());
      window.webContents.on("did-finish-load", () => {
        if (isAppUrl(window.webContents.getURL())) activation.notifyAppDocumentReady();
      });
    },
  };
}

/**
 * macOS can deliver a mailto before `ready` or while the window still shows
 * the splash. Queue it for the coordinator instead of sending into a renderer
 * that has no compose subscription yet.
 */
export function installOpenUrlHandling(app: App, activation: GuiActivation): void {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const mailtoUrl = extractMailtoUrl([url]);
    if (!mailtoUrl) return;
    activation.queueMailto(mailtoUrl);
  });
}
