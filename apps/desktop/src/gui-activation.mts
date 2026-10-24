/**
 * Serializes GUI activation hand-offs from a second launch (or an `open-url`
 * event) without assuming "boot finished" means the current window can already
 * receive a compose request.
 *
 * Startup has three relevant states: no window yet, a splash shell whose app
 * document has not loaded, and a loaded app document. A compose URL sent in the
 * first two states is lost, so it is queued until the window reports its app
 * document ready. The queue is also the single consumption point: every path
 * (boot, recreate, reload) flushes it at most once per ready transition.
 */
export type GuiActivationPorts = {
  /** Whether a main window exists at all (a splash shell counts). */
  hasMainWindow: () => boolean;
  /** Resolves once boot has finished (local service ready, initial window restore done). */
  waitForBoot: () => Promise<void>;
  /** Resolves once the current window's app document is loaded enough to receive IPC. */
  waitForAppDocument: () => Promise<void>;
  /** Creates the main window; the app document starts loading here. */
  createMainWindow: () => Promise<void>;
  focusMainWindow: () => void;
  deliverCompose: (mailtoUrl: string) => void;
  onError: (error: unknown) => void;
};

export type GuiActivation = {
  /** Queue a mailto hand-off; delivered now only if the app document is ready. */
  queueMailto: (mailtoUrl: string) => void;
  /** Focus or create the window. Concurrent calls share one in-flight attempt. */
  activate: () => Promise<void>;
  /** The current window started (re)loading its app document. */
  notifyLoading: () => void;
  /** The current window's app document finished loading. */
  notifyAppDocumentReady: () => void;
  /** The current window is gone; a later activation must wait for a new one. */
  notifyWindowClosed: () => void;
};

export function createGuiActivation(ports: GuiActivationPorts): GuiActivation {
  const pendingMailtoUrls: string[] = [];
  let appDocumentReady = false;
  let activation: Promise<void> | null = null;

  const canDeliver = (): boolean => appDocumentReady && ports.hasMainWindow();

  const flush = (): void => {
    if (!canDeliver()) return;
    const queued = pendingMailtoUrls.splice(0);
    for (const mailtoUrl of queued) ports.deliverCompose(mailtoUrl);
  };

  return {
    queueMailto(mailtoUrl) {
      pendingMailtoUrls.push(mailtoUrl);
      if (!canDeliver()) return;
      ports.focusMainWindow();
      flush();
    },
    activate() {
      // A burst of second-instance/open-url events must create at most one
      // window and run one boot wait; later callers await the same attempt.
      if (activation) return activation;
      activation = (async () => {
        try {
          await ports.waitForBoot();
          if (!ports.hasMainWindow()) await ports.createMainWindow();
          await ports.waitForAppDocument();
          ports.focusMainWindow();
          flush();
        } catch (error) {
          // The queue stays intact so the next activation can retry.
          ports.onError(error);
        } finally {
          activation = null;
        }
      })();
      return activation;
    },
    notifyLoading() {
      appDocumentReady = false;
    },
    notifyAppDocumentReady() {
      appDocumentReady = true;
      flush();
    },
    notifyWindowClosed() {
      appDocumentReady = false;
    },
  };
}
