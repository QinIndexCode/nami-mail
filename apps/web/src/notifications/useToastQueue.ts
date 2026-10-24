import { useCallback, useEffect, useReducer } from "react";
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
  icon?: ToastIcon;
  /**
   * Reports the outcome of an action the user just invoked (an undo's "started"
   * and "done"/"failed" notices).
   *
   * Without this, that report is an ordinary toast: it queues behind the next
   * actionable toast that the click promoted, so the answer to what the user
   * just did can stay hidden for up to six seconds. Feedback instead replaces
   * the visible toast and puts it back at the head of the queue, so the action
   * is displaced rather than destroyed and the report is the next thing shown.
   */
  feedback?: boolean;
};

export type ToastNotice = {
  id: string;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  priority: ToastPriority;
  icon?: ToastIcon;
};

type ToastQueueState = {
  active: ToastNotice | null;
  queue: ToastNotice[];
  nextId: number;
};

type ToastQueueAction =
  | { type: "show"; notice: Omit<ToastNotice, "id">; feedback: boolean }
  | { type: "dismiss" };

/**
 * The queue as a reducer, so React StrictMode's double invocation of updaters is
 * harmless: the same state and action always produce the same next state.
 *
 * It used to be two `useState` calls with the queue mutated inside the setter --
 * `showToast` pushed and `dismissToast` shifted during the updater. StrictMode
 * runs an updater twice, so a single dismiss consumed two queued toasts and a
 * single show enqueued one twice; the skipped action never reappeared. Moving the
 * queue into reducer state also keeps the id allocation in the same pure step.
 */
function toastQueueReducer(state: ToastQueueState, action: ToastQueueAction): ToastQueueState {
  if (action.type === "dismiss") {
    const [next, ...rest] = state.queue;
    return { active: next ?? null, queue: rest, nextId: state.nextId };
  }

  const notice: ToastNotice = { ...action.notice, id: `toast-${state.nextId}` };
  const nextId = state.nextId + 1;
  const current = state.active;
  if (!current?.action) return { active: notice, queue: state.queue, nextId };
  // An actionable toast (e.g. Undo) owns the screen until it is answered or
  // expires. Anything that arrives meanwhile queues behind it -- including a
  // second action: replacing the first would silently destroy an operation the
  // user could still take back. Feedback is the exception: it answers the action
  // that was just invoked, so it takes the screen and returns the displaced
  // toast to the front of the queue.
  if (action.feedback) return { active: notice, queue: [current, ...state.queue], nextId };
  return { active: current, queue: [...state.queue, notice], nextId };
}

const EMPTY_QUEUE: ToastQueueState = { active: null, queue: [], nextId: 1 };

export function useToastQueue() {
  const [state, dispatch] = useReducer(toastQueueReducer, EMPTY_QUEUE);
  const { active: activeToast } = state;

  const dismissToast = useCallback(() => {
    dispatch({ type: "dismiss" });
  }, []);

  const showToast = useCallback((
    message: string,
    kind: ToastKind = "success",
    actionOrOptions?: ToastAction | ToastOptions,
  ) => {
    let action: ToastAction | undefined;
    let priority: ToastPriority = "normal";
    let icon: ToastIcon | undefined;
    let feedback = false;

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
        feedback = opts.feedback === true && !action;
      }
    }

    dispatch({ type: "show", notice: { kind, message, action, priority, icon }, feedback });
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
