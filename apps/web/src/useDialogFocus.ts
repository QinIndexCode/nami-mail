import { useLayoutEffect, useRef, type RefObject } from "react";

type DialogFocusOptions = {
  restoreFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  suspended?: boolean;
};

const focusableSelector = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled):not([type=hidden])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => element.tabIndex >= 0 && canRestoreFocus(element));
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
  { restoreFocusRef, fallbackFocusRef, suspended = false }: DialogFocusOptions = {},
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
      (initialControl ?? dialog).focus();
    };
    const focusAnimationFrame = window.requestAnimationFrame(focusInitialControl);

    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || suspendedRef.current) return;
      const controls = focusableElements(dialog);
      if (!controls.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const preventFocusEscape = (event: FocusEvent) => {
      if (suspendedRef.current || dialog.contains(event.target as Node)) return;
      focusInitialControl();
    };

    document.addEventListener("keydown", keepFocusInDialog, true);
    document.addEventListener("focusin", preventFocusEscape, true);
    return () => {
      window.cancelAnimationFrame(focusAnimationFrame);
      document.removeEventListener("keydown", keepFocusInDialog, true);
      document.removeEventListener("focusin", preventFocusEscape, true);
      const restoreTarget = [restoreFocusRef?.current, previousFocusRef.current, fallbackFocusRef?.current]
        .find(canRestoreFocus);
      if (restoreTarget) {
        window.requestAnimationFrame(() => restoreTarget.focus());
      }
    };
  }, [active, dialogRef, fallbackFocusRef, restoreFocusRef]);
}
