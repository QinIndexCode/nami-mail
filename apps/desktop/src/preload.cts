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

type DesktopUpdateSnapshot = {
  phase: "unavailable" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";
  currentVersion: string;
  targetVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  suppression: "none" | "skipped" | "snoozed";
  remindAt: string | null;
  message: string;
};

const rendererEvents = globalThis as unknown as {
  addEventListener: (type: "online", listener: () => void) => void;
};
rendererEvents.addEventListener("online", () => {
  ipcRenderer.send("nami:update-network-online");
});

contextBridge.exposeInMainWorld("namiDesktop", {
  localApiRequestHeaders: () => ipcRenderer.invoke("nami:local-api-request-headers"),
  notify: (payload: NativeNotification) => ipcRenderer.invoke("nami:notify", payload),
  copyVerificationCode: (code: string) => ipcRenderer.invoke("nami:copy-verification-code", code),
  getUpdateStatus: (): Promise<DesktopUpdateSnapshot | undefined> => ipcRenderer.invoke("nami:update-get-status"),
  checkForUpdates: (): Promise<DesktopUpdateSnapshot | undefined> => ipcRenderer.invoke("nami:update-check"),
  downloadUpdate: (): Promise<DesktopUpdateSnapshot | undefined> => ipcRenderer.invoke("nami:update-download"),
  skipUpdate: (): Promise<DesktopUpdateSnapshot | undefined> => ipcRenderer.invoke("nami:update-skip"),
  snoozeUpdate: (durationMinutes: number): Promise<DesktopUpdateSnapshot | undefined> => ipcRenderer.invoke("nami:update-snooze", durationMinutes),
  installUpdate: (): Promise<{ accepted: boolean; snapshot?: DesktopUpdateSnapshot }> => ipcRenderer.invoke("nami:update-install"),
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
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: DesktopUpdateSnapshot) => listener(snapshot);
    ipcRenderer.on("nami:update-status", wrapped);
    return () => ipcRenderer.removeListener("nami:update-status", wrapped);
  },
});
