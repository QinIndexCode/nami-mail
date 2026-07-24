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
import { useI18n } from "./i18n";

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
 * A theme-owned listbox. It keeps the select interaction keyboard-accessible
 * while avoiding the browser's platform-specific option popup.
 */
export default function ThemedSelect({
  id,
  value,
  children,
  onValueChange,
  disabled = false,
  className = "",
  containerClassName = "",
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
  const [activeValue, setActiveValue] = useState(selectedEnabledValue);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const activeIndex = options.findIndex((option) => option.value === activeValue);
  const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined;

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) setActiveValue(selectedEnabledValue);
  }, [open, selectedEnabledValue]);

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
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
      setOpen(false);
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
      className={`select-control ${containerClassName}`.trim()}
      onBlur={(event) => {
        const nextFocusTarget = event.relatedTarget;
        if (!(nextFocusTarget instanceof Node) || !rootRef.current?.contains(nextFocusTarget)) setOpen(false);
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
            if (open) setOpen(false);
            else openMenu();
          }
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="themed-select-value">{selected?.label ?? t("common.notSelected")}</span>
        <ChevronDown className={`select-control-icon${open ? " open" : ""}`} size={15} aria-hidden="true" />
      </button>
      {open && (
        <span
          id={listboxId}
          className="themed-select-menu"
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
        </span>
      )}
    </span>
  );
}
