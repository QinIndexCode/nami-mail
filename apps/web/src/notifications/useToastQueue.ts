import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastKind } from "../mailUi";
export type { ToastKind };

export type ToastAction = {
  label: string;
  run: () => void;
  icon?: "video" | "calendar" | "undo";
};

export type ToastPriority = "action" | "normal" | "low";

export type ToastIcon = "mail" | "calendar" | "video" | "info" | "check" | "alert" | "undo";

export type ToastOptions = {
  action?: ToastAction;
  priority?: ToastPriority;
  durationMs?: number;
  icon?: ToastIcon;
};

export type ToastNotice = {
  id: string;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  priority: ToastPriority;
  icon?: ToastIcon;
};

export function useToastQueue() {
  const [activeToast, setActiveToast] = useState<ToastNotice | null>(null);
  const queueRef = useRef<ToastNotice[]>([]);
  const nextIdRef = useRef(1);

  const dismissToast = useCallback(() => {
    setActiveToast(() => {
      if (queueRef.current.length > 0) {
        return queueRef.current.shift()!;
      }
      return null;
    });
  }, []);

  const showToast = useCallback((
    message: string,
    kind: ToastKind = "success",
    actionOrOptions?: ToastAction | ToastOptions,
  ) => {
    let action: ToastAction | undefined;
    let priority: ToastPriority = "normal";
    let icon: ToastIcon | undefined;

    if (actionOrOptions) {
      if ("run" in actionOrOptions && typeof actionOrOptions.run === "function") {
        action = actionOrOptions as ToastAction;
        priority = "action";
        icon = (actionOrOptions as { icon?: ToastIcon }).icon;
      } else {
        const opts = actionOrOptions as ToastOptions;
        action = opts.action;
        priority = opts.priority ?? (action ? "action" : "normal");
        icon = opts.icon ?? opts.action?.icon;
      }
    }

    const newToast: ToastNotice = {
      id: `toast-${nextIdRef.current++}`,
      kind,
      message,
      action,
      priority,
      icon,
    };

    setActiveToast((current) => {
      // If an actionable toast (e.g. Undo action) is currently on screen,
      // lower-priority notifications must never overwrite and destroy it.
      // Instead, queue them to display right after the action expires or completes.
      if (current && current.action && priority !== "action") {
        queueRef.current.push(newToast);
        return current;
      }
      return newToast;
    });
  }, []);

  useEffect(() => {
    if (!activeToast) return;
    const duration = activeToast.action
      ? 6000
      : activeToast.kind === "warning"
        ? 8000
        : activeToast.kind === "error"
          ? 6000
          : 3200;

    const timer = window.setTimeout(dismissToast, duration);
    return () => window.clearTimeout(timer);
  }, [activeToast, dismissToast]);

  return {
    toast: activeToast,
    showToast,
    dismissToast,
  };
}
