import { Check, CircleHelp, Copy, Minimize2, Monitor, Moon, Power, Sun } from "lucide-react";
import { useI18n } from "../i18n";
import type { AppTheme, CloseBehavior } from "../types";

export function ExternalGuideBlock(props: {
  id: string;
  label: string;
  hint: string;
  code: string;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const { t } = useI18n();
  const copied = props.copiedId === props.id;
  return (
    <div className="external-guide-block">
      <div className="external-guide-block-head">
        <span>
          <strong>{props.label}</strong>
          <small>{props.hint}</small>
        </span>
        <button
          className="secondary-button"
          type="button"
          disabled={copied}
          aria-label={copied ? t("settings.agent.externalGuide.copied") : `${t("settings.agent.externalGuide.copy")} ${props.label}`}
          onClick={() => props.onCopy(props.code, props.id)}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t("settings.agent.externalGuide.copied") : t("settings.agent.externalGuide.copy")}
        </button>
      </div>
      <pre className="external-guide-code"><code>{props.code}</code></pre>
    </div>
  );
}

export function Switch({
  checked,
  disabled = false,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <div className="setting-row setting-switch-row">
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <button
        className={`setting-switch${checked ? " active" : ""}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

export function ThemeIcon({ value }: { value: AppTheme }) {
  if (value === "light") return <Sun size={17} />;
  if (value === "dark") return <Moon size={17} />;
  return <Monitor size={17} />;
}

export function NumberStepper({ value, min, max, onChange, disabled, decreaseLabel = "Decrease", increaseLabel = "Increase" }: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  decreaseLabel?: string;
  increaseLabel?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="number-stepper">
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= min} aria-label={decreaseLabel}>−</button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(clamp(n));
        }}
      />
      <button type="button" onClick={() => onChange(clamp(value + 1))} disabled={disabled || value >= max} aria-label={increaseLabel}>+</button>
    </div>
  );
}

export function CloseBehaviorIcon({ value }: { value: CloseBehavior }) {
  if (value === "tray") return <Minimize2 size={17} />;
  if (value === "quit") return <Power size={17} />;
  return <CircleHelp size={17} />;
}
