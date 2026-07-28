import { contextBridge, ipcRenderer } from "electron";

type NativeNotification = {
  title: string;
  body: string;
  silent: boolean;
};

type NewMailPayload = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  count: number;
  shouldAlert: boolean;
  playCustomSound: boolean;
};

const updatePhases = [
  "unavailable",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "error",
] as const;

const updateSuppressions = ["none", "skipped", "snoozed"] as const;

const updateReasons = [
  "initializing",
  "disabled",
  "unpackaged",
  "platformUnsupported",
  "sourceUnconfigured",
  "trustUnavailable",
  "scheduled",
  "checking",
  "upToDate",
  "releaseAvailable",
  "downloading",
  "downloadReady",
  "network",
  "tls",
  "releaseUnavailable",
  "rateLimited",
  "signatureInvalid",
  "integrityInvalid",
  "archiveIntegrityInvalid",
  "mailDataBusy",
  "installerNotStarted",
  "installResult",
  "unknown",
] as const;

const updateInstallStages = [
  "wait",
  "verify-archive",
  "extract",
  "verify-installer",
  "install",
  "cleanup",
  "restart",
] as const;

const updateSnapshotKeys = new Set([
  "schemaVersion",
  "phase",
  "currentVersion",
  "targetVersion",
  "percent",
  "checkedAt",
  "suppression",
  "remindAt",
  "reason",
  "args",
]);
const updateSnapshotArgumentKeys = new Set(["installStage", "cleanupComplete"]);
const updateInstallResultKeys = new Set(["accepted", "snapshot"]);
const agentConfirmationIpcChannel = "nami:resolve-agent-confirmation";
const agentConfirmationIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const agentConfirmationDecisions = ["approve", "reject"] as const;
const agentConfirmationResultKeys = new Set(["ok"]);
const agentConfirmationActionSelector = "button[data-nami-agent-confirmation-id][data-nami-agent-confirmation-decision]";
const agentConfirmationCardSelector = "[data-nami-agent-confirmation-card]";

export type DesktopUpdatePhase = typeof updatePhases[number];
export type DesktopUpdateSuppression = typeof updateSuppressions[number];
export type DesktopUpdateReason = typeof updateReasons[number];
export type DesktopUpdateInstallStage = typeof updateInstallStages[number];
export type DesktopAgentConfirmationDecision = typeof agentConfirmationDecisions[number];

export type DesktopUpdateSnapshotArgs = {
  installStage?: DesktopUpdateInstallStage;
  cleanupComplete?: boolean;
};

export type DesktopUpdateSnapshot = {
  schemaVersion: 2;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  targetVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  suppression: DesktopUpdateSuppression;
  remindAt: string | null;
  reason: DesktopUpdateReason;
  args: DesktopUpdateSnapshotArgs;
};

export type DesktopAgentConfirmationRequest = {
  confirmationId: string;
  decision: DesktopAgentConfirmationDecision;
};

export type DesktopAgentConfirmationResult = DesktopAgentConfirmationRequest & {
  ok: boolean;
};

type DesktopUpdateInstallResult = {
  accepted: boolean;
  snapshot?: DesktopUpdateSnapshot;
};

type ConfirmationActionElement = {
  disabled?: unknown;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => unknown;
};

type ConfirmationDocument = {
  addEventListener?: (type: "click", listener: (event: unknown) => void, options?: { capture?: boolean }) => void;
  removeEventListener?: (type: "click", listener: (event: unknown) => void, options?: { capture?: boolean }) => void;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key)) && Object.getOwnPropertySymbols(value).length === 0;
}

function hasAllKeys(value: Record<string, unknown>, requiredKeys: ReadonlySet<string>): boolean {
  return [...requiredKeys].every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}

function isAllowedValue<T extends string>(value: unknown, allowedValues: readonly T[]): value is T {
  return typeof value === "string" && (allowedValues as readonly string[]).includes(value);
}

function normalizeUpdateSnapshotArgs(value: unknown): DesktopUpdateSnapshotArgs | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, updateSnapshotArgumentKeys)) return undefined;
  const installStage = value.installStage;
  const cleanupComplete = value.cleanupComplete;
  if (installStage !== undefined && !isAllowedValue(installStage, updateInstallStages)) return undefined;
  if (cleanupComplete !== undefined && typeof cleanupComplete !== "boolean") return undefined;
  return {
    ...(installStage ? { installStage } : {}),
    ...(cleanupComplete === undefined ? {} : { cleanupComplete }),
  };
}

export function normalizeDesktopUpdateSnapshot(value: unknown): DesktopUpdateSnapshot | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, updateSnapshotKeys) || !hasAllKeys(value, updateSnapshotKeys)) return undefined;
  if (value.schemaVersion !== 2
    || !isAllowedValue(value.phase, updatePhases)
    || !isNonBlankString(value.currentVersion)
    || !isNullableNonBlankString(value.targetVersion)
    || (value.percent !== null && (typeof value.percent !== "number" || !Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100))
    || !isNullableNonBlankString(value.checkedAt)
    || !isAllowedValue(value.suppression, updateSuppressions)
    || !isNullableNonBlankString(value.remindAt)
    || !isAllowedValue(value.reason, updateReasons)) {
    return undefined;
  }
  const args = normalizeUpdateSnapshotArgs(value.args);
  if (!args) return undefined;
  return {
    schemaVersion: 2,
    phase: value.phase,
    currentVersion: value.currentVersion,
    targetVersion: value.targetVersion,
    percent: value.percent,
    checkedAt: value.checkedAt,
    suppression: value.suppression,
    remindAt: value.remindAt,
    reason: value.reason,
    args,
  };
}

export function normalizeDesktopUpdateInstallResult(value: unknown): DesktopUpdateInstallResult {
  if (!isPlainRecord(value)
    || !hasOnlyKeys(value, updateInstallResultKeys)
    || !Object.prototype.hasOwnProperty.call(value, "accepted")
    || typeof value.accepted !== "boolean") {
    return { accepted: false };
  }
  if (!Object.prototype.hasOwnProperty.call(value, "snapshot")) return { accepted: false };
  const snapshot = normalizeDesktopUpdateSnapshot(value.snapshot);
  return snapshot ? { accepted: value.accepted, snapshot } : { accepted: false };
}

function invokeUpdateSnapshot(channel: string, ...args: unknown[]): Promise<DesktopUpdateSnapshot | undefined> {
  return ipcRenderer.invoke(channel, ...args).then(normalizeDesktopUpdateSnapshot);
}

export function normalizeDesktopAgentConfirmationRequest(
  confirmationId: unknown,
  decision: unknown,
): DesktopAgentConfirmationRequest | undefined {
  if (typeof confirmationId !== "string" || !agentConfirmationIdentifierPattern.test(confirmationId)) return undefined;
  if (typeof decision !== "string" || !(agentConfirmationDecisions as readonly string[]).includes(decision)) return undefined;
  return { confirmationId, decision: decision as DesktopAgentConfirmationDecision };
}

function confirmationActionElement(value: unknown): ConfirmationActionElement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ConfirmationActionElement>;
  return typeof candidate.getAttribute === "function" && typeof candidate.closest === "function"
    ? candidate as ConfirmationActionElement
    : undefined;
}

function confirmationResolutionSucceeded(value: unknown): boolean {
  return isPlainRecord(value)
    && hasOnlyKeys(value, agentConfirmationResultKeys)
    && Object.prototype.hasOwnProperty.call(value, "ok")
    && value.ok === true;
}

/**
 * Browser-generated keyboard activation also creates a trusted click, while
 * HTMLElement.click() and dispatchEvent() do not. Do not use click.detail here.
 */
export function trustedDesktopAgentConfirmationRequest(event: unknown): DesktopAgentConfirmationRequest | undefined {
  if (!event || typeof event !== "object") return undefined;
  const click = event as { isTrusted?: unknown; target?: unknown };
  if (click.isTrusted !== true) return undefined;
  const target = confirmationActionElement(click.target);
  const button = target ? confirmationActionElement(target.closest(agentConfirmationActionSelector)) : undefined;
  if (!button || button.disabled === true) return undefined;
  const request = normalizeDesktopAgentConfirmationRequest(
    button.getAttribute("data-nami-agent-confirmation-id"),
    button.getAttribute("data-nami-agent-confirmation-decision"),
  );
  if (!request) return undefined;
  const card = confirmationActionElement(button.closest(agentConfirmationCardSelector));
  return card?.getAttribute("data-nami-agent-confirmation-id") === request.confirmationId ? request : undefined;
}

/**
 * The handler runs in preload's isolated world, before renderer click handlers.
 * Renderer code can subscribe to the outcome but cannot invoke this operation.
 */
export function installTrustedDesktopAgentConfirmationClickHandler(
  documentTarget: ConfirmationDocument | undefined,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  publish: (result: DesktopAgentConfirmationResult) => void,
): () => void {
  const inFlight = new Set<string>();
  const listener = (event: unknown) => {
    const request = trustedDesktopAgentConfirmationRequest(event);
    if (!request || inFlight.has(request.confirmationId)) return;
    inFlight.add(request.confirmationId);
    const publishResult = (ok: boolean) => publish(Object.freeze({ ...request, ok }));
    try {
      void invoke(agentConfirmationIpcChannel, request.confirmationId, request.decision)
        .then((result) => publishResult(confirmationResolutionSucceeded(result)), () => publishResult(false))
        .finally(() => inFlight.delete(request.confirmationId));
    } catch {
      publishResult(false);
      inFlight.delete(request.confirmationId);
    }
  };
  documentTarget?.addEventListener?.("click", listener, { capture: true });
  return () => documentTarget?.removeEventListener?.("click", listener, { capture: true });
}

const rendererEvents = globalThis as unknown as {
  addEventListener?: (type: "online", listener: () => void) => void;
  document?: ConfirmationDocument;
};
if (contextBridge && ipcRenderer) {
  const confirmationResultListeners = new Set<(result: DesktopAgentConfirmationResult) => void>();
  installTrustedDesktopAgentConfirmationClickHandler(
    rendererEvents.document,
    (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    (result) => {
      for (const listener of [...confirmationResultListeners]) {
        try {
          listener(result);
        } catch {
          // A renderer listener must not affect the desktop confirmation path.
        }
      }
    },
  );
  rendererEvents.addEventListener?.("online", () => {
    ipcRenderer.send("nami:update-network-online");
  });

  contextBridge.exposeInMainWorld("namiDesktop", {
    localApiRequestHeaders: () => ipcRenderer.invoke("nami:local-api-request-headers"),
    notify: (payload: NativeNotification) => ipcRenderer.invoke("nami:notify", payload),
    copyVerificationCode: (code: string) => ipcRenderer.invoke("nami:copy-verification-code", code),
    onAgentConfirmationResult: (listener: unknown) => {
      if (typeof listener !== "function") return () => undefined;
      const resultListener = listener as (result: DesktopAgentConfirmationResult) => void;
      confirmationResultListeners.add(resultListener);
      return () => confirmationResultListeners.delete(resultListener);
    },
    getUpdateStatus: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-get-status"),
    checkForUpdates: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-check"),
    downloadUpdate: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-download"),
    skipUpdate: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-skip"),
    snoozeUpdate: (durationMinutes: number): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-snooze", durationMinutes),
    installUpdate: (): Promise<DesktopUpdateInstallResult> => ipcRenderer.invoke("nami:update-install").then(normalizeDesktopUpdateInstallResult),
    setCustomNotificationSoundReady: (ready: boolean) => ipcRenderer.send("nami:custom-notification-sound-ready", ready),
    onNewMail: (listener: (payload: NewMailPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: NewMailPayload) => listener(payload);
      ipcRenderer.on("nami:new-mail", wrapped);
      return () => ipcRenderer.removeListener("nami:new-mail", wrapped);
    },
    onOpenMessage: (listener: (id: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
      ipcRenderer.on("nami:open-message", wrapped);
      return () => ipcRenderer.removeListener("nami:open-message", wrapped);
    },
    onSettingsChanged: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on("nami:settings-changed", wrapped);
      return () => ipcRenderer.removeListener("nami:settings-changed", wrapped);
    },
    onUpdateStatus: (listener: (snapshot: DesktopUpdateSnapshot) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
        const normalizedSnapshot = normalizeDesktopUpdateSnapshot(snapshot);
        if (normalizedSnapshot) listener(normalizedSnapshot);
      };
      ipcRenderer.on("nami:update-status", wrapped);
      return () => ipcRenderer.removeListener("nami:update-status", wrapped);
    },
  });
}
