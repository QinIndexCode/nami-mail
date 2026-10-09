import { useLayoutEffect, useRef, type RefObject } from "react";

type DialogFocusOptions = {
  restoreFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  suspended?: boolean;
  /** An embedded panel should not take focus before the visitor enters it. */
  deferInitialFocus?: boolean;
  /** Embedded overlays can focus controls without scrolling their host page. */
  preventScroll?: boolean;
};

const focusableSelector = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled):not([type=hidden])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => element.tabIndex >= 0 && canRestoreFocus(element));
}

/**
 * Body-level popups that belong to a dialog's focus trap.
 *
 * A popup that has to escape its dialog's overflow — the date picker panel is
 * clipped by every modal card, and two of those cards are themselves scroll
 * containers — cannot live inside the dialog subtree. Portalling it to
 * document.body puts it beyond `dialog.contains(...)`, which is the single
 * test this trap makes, and that is exactly why a body-portaled panel had its
 * focus yanked the instant a day button took it. Registering the popup here
 * gives the trap the scope the popup really has: the dialog plus the popups it
 * owns.
 *
 * Keyed by the dialog element so a nested trap (an editor inside the settings
 * dialog) only ever claims its own popups, never its ancestor's.
 */
const dialogPortals = new WeakMap<HTMLElement, Set<HTMLElement>>();

/** Registers `portal` as part of `dialog`'s focus scope. Returns the unregister. */
export function registerDialogPortal(dialog: HTMLElement, portal: HTMLElement): () => void {
  const portals = dialogPortals.get(dialog) ?? new Set<HTMLElement>();
  portals.add(portal);
  dialogPortals.set(dialog, portals);
  return () => {
    portals.delete(portal);
    if (!portals.size) dialogPortals.delete(dialog);
  };
}

function portalsOf(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialogPortals.get(dialog) ?? []);
}

/** Whether any popup is currently registered against `dialog` (e.g. an open date-picker panel). */
export function hasOpenDialogPortals(dialog: HTMLElement): boolean {
  return (dialogPortals.get(dialog)?.size ?? 0) > 0;
}

/** Dialog controls first, then each registered popup's — the composite Tab order. */
function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...focusableWithin(dialog), ...portalsOf(dialog).flatMap(focusableWithin)];
}

/** Whether `target` sits inside the dialog or inside a popup registered against it. */
export function isWithinDialogFocus(dialog: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  if (dialog.contains(target)) return true;
  return portalsOf(dialog).some((portal) => portal.contains(target));
}

function canRestoreFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element?.isConnected || element.getClientRects().length === 0) return false;
  if (element.matches(":disabled, [aria-disabled=\"true\"]") || element.closest("[inert]")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** Keeps keyboard focus inside application dialogs, including nested alerts. */
export function useDialogFocus(
  active: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  { restoreFocusRef, fallbackFocusRef, suspended = false, deferInitialFocus = false, preventScroll = false }: DialogFocusOptions = {},
): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const suspendedRef = useRef(suspended);

  useLayoutEffect(() => {
    suspendedRef.current = suspended;
  }, [suspended]);

  useLayoutEffect(() => {
    if (!active) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusInitialControl = () => {
      const preferred = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      const initialControl = preferred && preferred.tabIndex >= 0 && canRestoreFocus(preferred)
        ? preferred
        : focusableElements(dialog)[0];
      (initialControl ?? dialog).focus({ preventScroll });
    };
    const focusAnimationFrame = deferInitialFocus ? null : window.requestAnimationFrame(focusInitialControl);

    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || suspendedRef.current) return;
      const controls = focusableElements(dialog);
      if (!controls.length) {
        event.preventDefault();
        dialog.focus({ preventScroll });
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!isWithinDialogFocus(dialog, document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll });
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll });
      }
    };

    // Guards against two focus traps (e.g. the Agent workspace and an
    // application dialog) fighting over the focus synchronously. Each trap
    // pulls focus back via .focus(), which synchronously dispatches focusin;
    // without this guard the pair would recurse until the stack overflows.
    // Standing down on the second nested call lets the other trap win and
    // the loop converges.
    let focusLoopGuard = 0;
    const preventFocusEscape = (event: FocusEvent) => {
      if (suspendedRef.current || isWithinDialogFocus(dialog, event.target)) return;
      if (focusLoopGuard > 1) return;
      focusLoopGuard += 1;
      try {
        focusInitialControl();
      } finally {
        focusLoopGuard -= 1;
      }
    };

    document.addEventListener("keydown", keepFocusInDialog, true);
    document.addEventListener("focusin", preventFocusEscape, true);
    return () => {
      if (focusAnimationFrame !== null) window.cancelAnimationFrame(focusAnimationFrame);
      document.removeEventListener("keydown", keepFocusInDialog, true);
      document.removeEventListener("focusin", preventFocusEscape, true);
      // The cleanup reads the latest refs on purpose: focus returns to the
      // most recent owner, even if a dialog swap updated the target mid-flight.
      // A macrotask (not requestAnimationFrame) defers past the React commit
      // while still running in hidden windows, where rAF is paused and would
      // drop the restore entirely.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const restoreTarget = [restoreFocusRef?.current, previousFocusRef.current, fallbackFocusRef?.current]
        .find(canRestoreFocus);
      if (restoreTarget) {
        window.setTimeout(() => restoreTarget.focus({ preventScroll }), 0);
      }
    };
  }, [active, deferInitialFocus, dialogRef, fallbackFocusRef, preventScroll, restoreFocusRef]);
}
