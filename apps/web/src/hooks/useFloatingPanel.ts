import { useEffect, type RefObject } from "react";
import { autoUpdate, computePosition, flip, offset, shift, size, type Placement } from "@floating-ui/dom";
import { registerDialogPortal } from "./useDialogFocus";

/**
 * The dialog whose focus trap owns a portaled panel, if any. A ref is accepted
 * because callers usually hold the dialog element in one; it is dereferenced
 * inside effects, which always run after the dialog element is attached.
 */
export type PanelHost = HTMLElement | RefObject<HTMLElement | null> | null | undefined;

export function resolvePanelHost(host: PanelHost): HTMLElement | null {
  if (!host) return null;
  return "current" in host ? host.current : host;
}

type FloatingPanelOptions = {
  /** Whether the panel is present and should track its trigger. */
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  /** Element that owns the panel's focus scope when the panel is portaled out of a dialog. */
  panelHost?: PanelHost;
  /** Preferred side; `flip()` still picks the other one when this side has no room. */
  placement?: Placement;
  /** Gap between trigger and panel, in px. */
  offsetPx?: number;
  /**
   * Stretch the panel to at least its trigger's width and cap it to the width
   * the viewport offers. Select dropdowns want this; panels with their own
   * intrinsic width (the date picker) do not.
   */
  matchTriggerWidth?: boolean;
};

/**
 * Places a popup panel that lives outside its trigger's DOM subtree.
 *
 * Panels are expected to be portaled to `document.body`: every dialog card
 * clips its overflow, and two of them are scroll containers, so an in-dialog
 * `position: absolute` panel is both cut off and pushed along with the content.
 * Floating-UI owns placement once the panel is out there: `flip` picks the side
 * with room, `shift` keeps it inside the viewport, `autoUpdate` repositions it
 * across scrolling (the settings dialog body is its own scroller) and resizing,
 * and `size` publishes the space the viewport actually offers through
 * `--floating-panel-max-height` so the stylesheet keeps its design cap:
 *
 *   max-height: min(280px, 44dvh, var(--floating-panel-max-height, 100dvh));
 *
 * `fixed` is the correct strategy for a body portal: the panel has no
 * transformed ancestor, so its containing block is the viewport.
 *
 * `panelHost` only matters for panels that take focus (the date picker's grid
 * buttons do; a select's options stay at tabIndex -1). Portaling puts them
 * beyond `dialog.contains(...)`, which is the test the focus trap makes, so the
 * host dialog must be told the panel belongs to it — otherwise the trap yanks
 * focus straight back out. See registerDialogPortal.
 */
export function useFloatingPanel({
  open,
  triggerRef,
  panelRef,
  panelHost,
  placement = "bottom-start",
  offsetPx = 6,
  matchTriggerWidth = false,
}: FloatingPanelOptions): void {
  const hostElement = resolvePanelHost(panelHost);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !hostElement || !panel) return undefined;
    return registerDialogPortal(hostElement, panel);
  }, [open, hostElement, panelRef]);

  useEffect(() => {
    if (!open) return undefined;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return undefined;
    const update = () => {
      void computePosition(trigger, panel, {
        strategy: "fixed",
        placement,
        middleware: [
          offset(offsetPx),
          flip(),
          // Cap the panel at the space the viewport actually offers: shift only
          // moves the cross axis, so on a short window neither flip side fits
          // and the panel would run off-viewport. size() publishes the height
          // budget instead of writing max-height directly, so the stylesheet
          // keeps its own cap (280px / 44dvh) as an upper bound.
          size({
            padding: 8,
            apply({ availableHeight, availableWidth, elements, rects }) {
              elements.floating.style.setProperty(
                "--floating-panel-max-height",
                `${Math.max(0, availableHeight)}px`,
              );
              if (!matchTriggerWidth) return;
              // The trigger's width is the floor (a 96px filter-value select
              // keeps its menu readable), the content's max-content width is
              // the natural size, and the viewport is the ceiling.
              elements.floating.style.minWidth = `${rects.reference.width}px`;
              elements.floating.style.maxWidth = `${Math.max(availableWidth, rects.reference.width)}px`;
            },
          }),
          shift({ padding: 8 }),
        ],
      }).then(({ x, y }) => {
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
      });
    };
    update();
    return autoUpdate(trigger, panel, update);
  }, [open, placement, offsetPx, matchTriggerWidth, triggerRef, panelRef]);
}
