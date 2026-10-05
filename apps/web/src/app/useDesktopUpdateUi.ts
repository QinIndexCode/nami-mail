import { useCallback, useEffect, useRef, useState } from "react";
import { desktopBridge, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "../desktop";
import { resolveUpdateFooter, type UpdateFooterAction } from "../updateFooter";
import { handleDemoUpdateFooterAction, resolveDemoUpdateSnapshot } from "../demoUpdateMock";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];

export interface DesktopUpdateUiOptions {
  isDemo: boolean;
  t: Translate;
  showToast: ShowToast;
}

export interface DesktopUpdateUi {
  desktopUpdateStatus: DesktopUpdateSnapshot | null;
  setDesktopUpdateStatus: (snapshot: DesktopUpdateSnapshot | null) => void;
  runUpdateFooterAction: (action: UpdateFooterAction) => Promise<void>;
  updateFooterAction: UpdateFooterAction | null;
  updateFooterBusy: boolean;
  updateBadgeDismissed: boolean;
  updateBadgeHidden: boolean;
  dismissUpdateBadge: () => void;
}

export function useDesktopUpdateUi({ isDemo, t, showToast }: DesktopUpdateUiOptions): DesktopUpdateUi {
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateSnapshot | null>(() => resolveDemoUpdateSnapshot(isDemo));
  const [updateFooterBusy, setUpdateFooterBusy] = useState(false);
  const updateEventSeqRef = useRef(0);
  // Update badge (available phase): a circular arrow chip that expands into a
  // pill on hover. Dismissing fades the pill back into the circle and then
  // out entirely; any phase/version change brings a fresh badge back.
  const [updateBadgeDismissed, setUpdateBadgeDismissed] = useState(false);
  const [updateBadgeHidden, setUpdateBadgeHidden] = useState(false);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return undefined;
    let active = true;
    let receivedUpdateEvent = false;
    const removeListener = bridge.onUpdateStatus((snapshot) => {
      receivedUpdateEvent = true;
      updateEventSeqRef.current += 1;
      if (active) setDesktopUpdateStatus(snapshot);
    });
    void bridge.getUpdateStatus().then((snapshot) => {
      // Prefer a broadcast received after subscription over an older IPC
      // snapshot, so a just-found release cannot be hidden by a race.
      if (active && !receivedUpdateEvent && snapshot) setDesktopUpdateStatus(snapshot);
    }).catch(() => undefined);
    return () => {
      active = false;
      removeListener();
    };
  }, []);

  const runUpdateFooterAction = useCallback(async (action: UpdateFooterAction) => {
    const bridge = desktopBridge();
    if (!bridge && isDemo) {
      handleDemoUpdateFooterAction(action, setDesktopUpdateStatus, showToast, t);
      return;
    }
    if (!bridge || updateFooterBusy) return;
    setUpdateFooterBusy(true);
    // A download/check broadcasts progress while it runs; the snapshot the call
    // resolves with was taken before those events, so applying it blindly would
    // walk the progress bar backwards. Only a snapshot from a window with no
    // intervening event may win (same rule the subscription above uses).
    const seqAtStart = updateEventSeqRef.current;
    const applyIfNewest = (snapshot: DesktopUpdateSnapshot | undefined | null) => {
      if (snapshot && updateEventSeqRef.current === seqAtStart) setDesktopUpdateStatus(snapshot);
    };
    try {
      if (action.kind === "download") {
        applyIfNewest(await bridge.downloadUpdate());
      } else if (action.kind === "install") {
        const result = await bridge.installUpdate();
        setDesktopUpdateStatus((current) => result.snapshot ?? current);
        if (!result.accepted && !result.snapshot) showToast(t("update.prompt.error.notReady"), "error");
      } else {
        applyIfNewest(await bridge.checkForUpdates());
      }
    } catch (error) {
      showToast(updateBridgeErrorMessage(error, t("update.prompt.error.action"), t), "error");
    } finally {
      setUpdateFooterBusy(false);
    }
  }, [isDemo, showToast, t, updateFooterBusy]);

  const updateFooterAction = resolveUpdateFooter(desktopUpdateStatus);
  const updateBadgeVersion = desktopUpdateStatus?.phase === "available" ? desktopUpdateStatus.targetVersion : null;
  useEffect(() => {
    setUpdateBadgeDismissed(false);
    setUpdateBadgeHidden(false);
  }, [updateBadgeVersion]);
  const dismissUpdateBadge = useCallback(() => {
    setUpdateBadgeDismissed(true);
    window.setTimeout(() => setUpdateBadgeHidden(true), 560);
  }, []);

  return {
    desktopUpdateStatus,
    setDesktopUpdateStatus,
    runUpdateFooterAction,
    updateFooterAction,
    updateFooterBusy,
    updateBadgeDismissed,
    updateBadgeHidden,
    dismissUpdateBadge,
  };
}
