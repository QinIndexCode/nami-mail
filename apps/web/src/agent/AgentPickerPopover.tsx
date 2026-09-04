import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/**
 * Shared upward accordion panel used by the composer permission and model
 * pickers. Wraps the options in the animated popover surface and provides
 * roving-tabindex keyboard navigation (Arrow/Home/End), focusing the checked
 * option when it opens so the menu is immediately keyboard-ready. Options are
 * native buttons, so Enter/Space activate them without extra wiring.
 */
export function AgentPickerPopover({
  id,
  anchor,
  visible,
  label,
  children,
}: {
  id: string;
  anchor: "left" | "right";
  visible: boolean;
  label: string;
  children: ReactNode;
}) {
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const host = innerRef.current;
    if (!host) return;
    const checked = host.querySelector<HTMLButtonElement>('.agent-popover-option[aria-checked="true"]');
    const target = checked ?? host.querySelector<HTMLButtonElement>(".agent-popover-option");
    target?.focus({ preventScroll: true });
  }, [visible]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const host = innerRef.current;
    if (!host) return;
    const options = Array.from(host.querySelectorAll<HTMLButtonElement>(".agent-popover-option"));
    if (options.length === 0) return;
    const current = document.activeElement;
    const index = options.indexOf(current as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = index === -1 ? 0 : Math.min(index + 1, options.length - 1);
    else if (event.key === "ArrowUp") next = index === -1 ? options.length - 1 : Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else next = options.length - 1;
    event.preventDefault();
    options[next]?.focus({ preventScroll: true });
  };

  return (
    <div id={id} className={`agent-popover anchor-${anchor}${visible ? " show" : ""}`} role="menu" aria-label={label} onKeyDown={handleKeyDown}>
      <div className="agent-popover-inner" ref={innerRef}>
        {children}
      </div>
    </div>
  );
}
