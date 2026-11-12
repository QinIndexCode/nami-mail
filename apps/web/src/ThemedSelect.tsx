import { Check, ChevronDown } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";
import { usePopupExitTransition } from "./hooks/usePopupExitTransition";
import { useFloatingPanel } from "./hooks/useFloatingPanel";

type SelectOption = {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
};

type OptionGroup = {
  group?: string;
  options: SelectOption[];
};

type ThemedSelectProps = {
  id: string;
  value: string | number;
  children: ReactNode;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  containerClassName?: string;
  /**
   * Preferred side for the menu. `flip()` still picks the other side when this
   * one has no room, so this is a hint, not an override.
   */
  menuPlacement?: "bottom" | "top";
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-label"?: string;
};

type OptionProps = {
  children?: ReactNode;
  disabled?: boolean;
  label?: string;
  value?: string | number;
};

function textFromNode(node: ReactNode): string {
  return Children.toArray(node).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<OptionProps>(child)) return textFromNode(child.props.children);
    return "";
  }).join("").replace(/\s+/g, " ").trim();
}

function extractOptions(children: ReactNode, group?: string): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionProps>(child)) return [];
    if (child.type === "optgroup") {
      return extractOptions(child.props.children, child.props.label);
    }
    if (child.type !== "option") return [];
    const label = textFromNode(child.props.children);
    return [{
      value: String(child.props.value ?? label),
      label,
      disabled: Boolean(child.props.disabled),
      ...(group ? { group } : {}),
    }];
  });
}

/**
 * Whether a listbox owned by a trigger inside `scope` is open (and not already
 * playing its exit transition).
 *
 * Menus are portaled to document.body, so they are no longer descendants of a
 * panel that hosts their trigger. Callers that layer Escape (the date picker
 * panel) must ask this instead of querying `.themed-select-menu` inside
 * themselves — the trigger stays where it was rendered, and `aria-controls`
 * names the listbox it currently owns.
 */
export function hasOpenSelectMenuWithin(scope: HTMLElement): boolean {
  return Array.from(scope.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"]')).some((trigger) => {
    const menuId = trigger.getAttribute("aria-controls");
    const menu = menuId ? document.getElementById(menuId) : null;
    return menu !== null && !menu.classList.contains("closing");
  });
}

/**
 * A theme-owned listbox. It keeps the select interaction keyboard-accessible
 * while avoiding the browser's platform-specific option popup.
 *
 * The menu is portaled to document.body and placed by floating-ui: every dialog
 * card clips its overflow and the settings body is its own scroll container, so
 * an in-flow menu both stretched its container (the bug this replaces) and got
 * cut off in narrow rows. Focus stays on the trigger throughout — options are
 * `tabIndex={-1}` and mousedown is cancelled — so the portaled menu never needs
 * registering with a dialog's focus trap.
 */
export default function ThemedSelect({
  id,
  value,
  children,
  onValueChange,
  disabled = false,
  className = "",
  containerClassName = "",
  menuPlacement = "bottom",
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-label": ariaLabel,
}: ThemedSelectProps) {
  const { t } = useI18n();
  const options = useMemo(() => extractOptions(children), [children]);
  const selectedValue = String(value);
  const selected = options.find((option) => option.value === selectedValue) ?? options.find((option) => !option.disabled);
  const enabledOptions = options.filter((option) => !option.disabled);
  const selectedEnabledValue = selected && !selected.disabled ? selected.value : enabledOptions[0]?.value ?? "";
  const optionGroups = useMemo(() => options.reduce<OptionGroup[]>((groups, option) => {
    const currentGroup = groups.at(-1);
    if (currentGroup && currentGroup.group === option.group) {
      currentGroup.options.push(option);
    } else {
      groups.push({ group: option.group, options: [option] });
    }
    return groups;
  }, []), [options]);
  const [open, setOpen] = useState(false);
  const { mounted: menuMounted, closing: menuClosing, beginClose: beginMenuClose } = usePopupExitTransition(open, () => setOpen(false));
  const [activeValue, setActiveValue] = useState(selectedEnabledValue);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const listboxId = useId();
  const activeIndex = options.findIndex((option) => option.value === activeValue);
  const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined;
  const isDropup = menuPlacement === "top" || containerClassName.includes("dropup");

  useFloatingPanel({
    open,
    triggerRef,
    panelRef: menuRef,
    placement: isDropup ? "top-start" : "bottom-start",
    matchTriggerWidth: true,
  });

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The menu is portaled out of the trigger wrapper, so the check must
      // cover it explicitly or the press that picks an option closes the menu
      // before the option's click handler runs.
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      beginMenuClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open, beginMenuClose]);

  useEffect(() => {
    if (!open) setActiveValue(selectedEnabledValue);
  }, [open, selectedEnabledValue]);

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    beginMenuClose();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveActive = (direction: 1 | -1, currentValue = activeValue) => {
    if (!enabledOptions.length) return;
    const index = enabledOptions.findIndex((option) => option.value === currentValue);
    const nextIndex = index < 0
      ? direction === 1 ? 0 : enabledOptions.length - 1
      : (index + direction + enabledOptions.length) % enabledOptions.length;
    const next = enabledOptions[nextIndex];
    if (next) setActiveValue(next.value);
  };

  const openMenu = (nextActiveValue = selectedEnabledValue) => {
    setActiveValue(nextActiveValue);
    setOpen(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !enabledOptions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) openMenu(selectedEnabledValue);
      moveActive(1, open ? activeValue : selectedEnabledValue);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) openMenu(selectedEnabledValue);
      moveActive(-1, open ? activeValue : selectedEnabledValue);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) setOpen(true);
      setActiveValue(event.key === "Home" ? enabledOptions[0]?.value ?? "" : enabledOptions.at(-1)?.value ?? "");
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      beginMenuClose();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        openMenu();
        return;
      }
      const active = enabledOptions.find((option) => option.value === activeValue)
        ?? enabledOptions.find((option) => option.value === selectedEnabledValue);
      if (active) choose(active);
    }
  };

  return (
    <span
      ref={rootRef}
      className={`select-control${isDropup ? " dropup" : ""} ${containerClassName}`.trim()}
      onBlur={(event) => {
        const nextFocusTarget = event.relatedTarget;
        if (
          !(nextFocusTarget instanceof Node)
          || (!rootRef.current?.contains(nextFocusTarget) && !menuRef.current?.contains(nextFocusTarget))
        ) beginMenuClose();
      }}
    >
      <button
        ref={triggerRef}
        id={id}
        className={`themed-select ${className}`.trim()}
        type="button"
        role="combobox"
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        aria-invalid={ariaInvalid}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            if (open) beginMenuClose();
            else openMenu();
          }
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="themed-select-value">{selected?.label ?? t("common.notSelected")}</span>
        <ChevronDown className={`select-control-icon${open ? " open" : ""}`} size={15} aria-hidden="true" />
      </button>
      {menuMounted && createPortal(
        <span
          ref={menuRef}
          id={listboxId}
          className={`themed-select-menu${menuClosing ? " closing" : ""}`}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : id}
        >
          {optionGroups.map((optionGroup, groupIndex) => {
            const groupOptions = optionGroup.options.map((option) => {
              const index = options.indexOf(option);
              return (
                <span
                  key={`${option.group ?? ""}:${option.value}`}
                  id={`${listboxId}-${index}`}
                  className={`themed-select-option${option.value === selected?.value ? " selected" : ""}${option.value === activeValue ? " active" : ""}`}
                  role="option"
                  aria-selected={option.value === selected?.value}
                  aria-disabled={option.disabled || undefined}
                  tabIndex={-1}
                  style={option.disabled ? { cursor: "default", opacity: 0.45 } : undefined}
                  onMouseEnter={() => {
                    if (!option.disabled) setActiveValue(option.value);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    choose(option);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === selected?.value && <Check size={14} aria-hidden="true" />}
                </span>
              );
            });

            if (!optionGroup.group) return groupOptions;
            return (
              <span key={`group:${optionGroup.group}:${groupIndex}`} role="group" aria-label={optionGroup.group}>
                <span className="themed-select-group" aria-hidden="true">{optionGroup.group}</span>
                {groupOptions}
              </span>
            );
          })}
        </span>,
        document.body,
      )}
    </span>
  );
}
