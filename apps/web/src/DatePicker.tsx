import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { buildGrid, dateKey, pad, parseTime, parseValue, timeValue } from "./datePickerUtils";
import { useI18n } from "./i18n";

export type DatePickerMode = "date" | "datetime";

type DatePickerProps = {
  mode: DatePickerMode;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
  /** Optional first date that cannot be picked (inclusive), e.g. the start of a range. */
  minDate?: string;
  /** Optional last date that cannot be picked (inclusive). */
  maxDate?: string;
};

type PanelView = "day" | "month" | "year";

const MONTHS_PER_YEAR = 12;

/**
 * A theme-owned date (and optional time) picker. It replaces the browser's
 * platform-native calendar/time popup with the app's visual language while
 * keeping the native value protocol (`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`) so
 * callers' data layer stays untouched.
 */
export default function DatePicker({
  mode,
  value,
  onChange,
  disabled = false,
  className = "",
  placeholder,
  "aria-label": ariaLabel,
  minDate,
  maxDate,
}: DatePickerProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PanelView>("day");
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const base = parseValue(value, mode).date ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [anchorStyle, setAnchorStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const parsed = useMemo(() => parseValue(value, mode), [value, mode]);
  const { hour, minute } = useMemo(() => parseTime(parsed.time), [parsed.time]);
  const todayKey = useMemo(() => dateKey(new Date()), []);
  const selectedKey = parsed.date ? dateKey(parsed.date) : "";

  // Reposition the panel when it would overflow the viewport edge. Runs in
  // every panel view (day/month/year) and whenever its height changes (the
  // time row appears/disappears) so narrow triggers never clip the popup.
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const next: CSSProperties = {};
      if (rect.right > window.innerWidth - 8) {
        next.left = "auto";
        next.right = 0;
      }
      if (rect.bottom > window.innerHeight - 8) {
        next.top = "auto";
        next.bottom = "calc(100% + 6px)";
      }
      setAnchorStyle(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, view, selectedKey, parsed.time, mode]);

  // Sync the focused day when the panel opens or the selected date changes.
  useEffect(() => {
    if (open && view === "day") setFocusedKey(selectedKey || todayKey);
  }, [open, view, selectedKey, todayKey]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);
  const monthLongFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }), [locale]);
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);
  const weekdays = useMemo(() => {
    const base = new Date(2026, 0, 5); // Monday.
    return Array.from({ length: 7 }, (_, index) => dayFormatter.format(new Date(base.getFullYear(), base.getMonth(), base.getDate() + index)));
  }, [dayFormatter]);
  const gridDays = useMemo(() => buildGrid(viewMonth), [viewMonth]);
  const monthLabel = monthLongFormatter.format(viewMonth);
  const year = viewMonth.getFullYear();

  // Year view shows a rolling 12-year window centred on the viewed year.
  const yearWindowStart = year - 5;
  const yearWindow = useMemo(() => Array.from({ length: MONTHS_PER_YEAR }, (_, index) => yearWindowStart + index), [yearWindowStart]);
  const displayValue = useMemo(() => {
    if (!parsed.date) return "";
    const dateFormatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
    const dateText = dateFormatter.format(parsed.date);
    return mode === "datetime" ? `${dateText} ${parsed.time}` : dateText;
  }, [locale, mode, parsed]);

  const hours = useMemo(() => Array.from({ length: 24 }, (_, index) => pad(index)), []);
  const minutes = useMemo(() => Array.from({ length: 12 }, (_, index) => pad(index * 5)), []);

  const inRange = (day: Date): boolean => {
    const key = dateKey(day);
    if (minDate && key < minDate) return false;
    if (maxDate && key > maxDate) return false;
    return true;
  };

  const emitValue = (day: Date) => {
    const nextDate = dateKey(day);
    if (!inRange(day)) return;
    onChange(mode === "datetime" ? `${nextDate}T${parsed.time}` : nextDate);
  };

  const pickDate = (day: Date) => {
    emitValue(day);
    if (mode === "date") setOpen(false);
  };

  const pickTime = (nextTime: string) => {
    const nextDate = dateKey(parsed.date ?? new Date());
    onChange(`${nextDate}T${nextTime}`);
  };

  const shiftViewMonth = (delta: number) => {
    setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  const shiftViewYear = (delta: number) => {
    setViewMonth((current) => new Date(current.getFullYear() + delta, current.getMonth(), 1));
  };

  const selectMonth = (monthIndex: number) => {
    setViewMonth((current) => new Date(current.getFullYear(), monthIndex, 1));
    setView("day");
  };

  const selectYear = (nextYear: number) => {
    setViewMonth((current) => new Date(nextYear, current.getMonth(), 1));
    setView("month");
  };

  const jumpToToday = () => {
    const today = new Date();
    emitValue(today);
    setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setView("day");
    if (mode === "date") setOpen(false);
  };

  const toggle = () => {
    if (disabled) return;
    setOpen((current) => !current);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") setOpen(false);
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) return;
    const currentIndex = gridDays.findIndex((day) => dateKey(day) === focusedKey);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") nextIndex = currentIndex - 1;
    if (event.key === "ArrowRight") nextIndex = currentIndex + 1;
    if (event.key === "ArrowUp") nextIndex = currentIndex - 7;
    if (event.key === "ArrowDown") nextIndex = currentIndex + 7;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pickDate(gridDays[currentIndex]);
      return;
    }
    event.preventDefault();
    const nextDay = gridDays[nextIndex];
    if (!nextDay) return;
    const nextKey = dateKey(nextDay);
    setFocusedKey(nextKey);
    // Keep the view in sync when the focus crosses a month boundary.
    setViewMonth(new Date(nextDay.getFullYear(), nextDay.getMonth(), 1));
  };

  const gridDayProps = (day: Date) => {
    const key = dateKey(day);
    const isCurrentMonth = day.getMonth() === viewMonth.getMonth();
    const isToday = key === todayKey;
    const isSelected = key === selectedKey;
    const isDisabled = !inRange(day);
    const isFocused = key === focusedKey;
    return {
      type: "button" as const,
      role: "gridcell" as const,
      className: `date-picker-day${isCurrentMonth ? "" : " outside"}${isToday ? " today" : ""}${isSelected ? " selected" : ""}${isFocused ? " focused" : ""}`,
      disabled: isDisabled,
      tabIndex: isFocused ? 0 : -1,
      "aria-label": new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(day),
      "aria-selected": isSelected,
      onClick: () => pickDate(day),
      onFocus: () => setFocusedKey(key),
    };
  };

  const navTitle = view === "day"
    ? <button type="button" className="date-picker-nav-title" onClick={() => setView("month")} aria-label={t("datePicker.chooseMonth")}>{monthLabel}</button>
    : view === "month"
      ? <button type="button" className="date-picker-nav-title" onClick={() => setView("year")} aria-label={t("datePicker.chooseYear")}>{year}</button>
      : <span className="date-picker-nav-title">{t("datePicker.yearRange", { start: yearWindowStart, end: yearWindowStart + MONTHS_PER_YEAR - 1 })}</span>;

  const navPrevious = view === "day"
    ? () => shiftViewMonth(-1)
    : view === "month"
      ? () => shiftViewYear(-1)
      : () => shiftViewYear(-MONTHS_PER_YEAR);
  const navNext = view === "day"
    ? () => shiftViewMonth(1)
    : view === "month"
      ? () => shiftViewYear(1)
      : () => shiftViewYear(MONTHS_PER_YEAR);
  const navPreviousLabel = view === "day" ? t("datePicker.previousMonth") : view === "month" ? t("datePicker.previousYear") : t("datePicker.previousYears");
  const navNextLabel = view === "day" ? t("datePicker.nextMonth") : view === "month" ? t("datePicker.nextYear") : t("datePicker.nextYears");

  const renderDayView = () => (
    <>
      <div className="date-picker-weekdays" aria-hidden="true">
        {weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="date-picker-grid" role="grid" aria-label={monthLabel} onKeyDown={handleGridKeyDown}>
        {gridDays.map((day) => <button key={dateKey(day)} {...gridDayProps(day)}>{day.getDate()}</button>)}
      </div>
      {mode === "datetime" && (
        <div className="date-picker-time">
          <span className="date-picker-time-label">{t("datePicker.time")}</span>
          <span className="date-picker-time-segments">
            <select className="date-picker-select" value={hour} aria-label={t("datePicker.hours")} onChange={(event) => pickTime(timeValue(event.target.value, minute))}>
              {hours.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <span aria-hidden="true">:</span>
            <select className="date-picker-select" value={minute} aria-label={t("datePicker.minutes")} onChange={(event) => pickTime(timeValue(hour, event.target.value))}>
              {minutes.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </span>
        </div>
      )}
      <button type="button" className="date-picker-today" onClick={jumpToToday}><CalendarDays size={12} aria-hidden="true" />{t("datePicker.today")}</button>
    </>
  );

  const renderMonthView = () => (
    <div className="date-picker-months" role="grid" aria-label={t("datePicker.chooseMonth")}>
      {Array.from({ length: MONTHS_PER_YEAR }, (_, index) => {
        const isCurrent = new Date().getMonth() === index && year === new Date().getFullYear();
        return (
          <button key={index} type="button" role="gridcell" className={`date-picker-month${isCurrent ? " today" : ""}`} onClick={() => selectMonth(index)}>
            {monthFormatter.format(new Date(2000, index, 1))}
          </button>
        );
      })}
    </div>
  );

  const renderYearView = () => (
    <div className="date-picker-years" role="grid" aria-label={t("datePicker.chooseYear")}>
      {yearWindow.map((yearValue) => {
        const isCurrent = yearValue === new Date().getFullYear();
        return (
          <button key={yearValue} type="button" role="gridcell" className={`date-picker-year${isCurrent ? " today" : ""}`} onClick={() => selectYear(yearValue)}>
            {yearValue}
          </button>
        );
      })}
    </div>
  );

  return (
    <span ref={rootRef} className={`date-picker${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="date-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={handleTriggerKeyDown}
      >
        <CalendarDays size={14} aria-hidden="true" />
        <span className={displayValue ? "" : "placeholder"}>{displayValue || placeholder || t("datePicker.placeholder")}</span>
      </button>
      {open && (
        <div
          id={panelId}
          ref={panelRef}
          className="date-picker-panel"
          style={anchorStyle}
          role="dialog"
          aria-label={ariaLabel || t("datePicker.panelLabel")}
        >
          <div className="date-picker-nav">
            <button type="button" className="date-picker-nav-button" aria-label={navPreviousLabel} onClick={navPrevious}><ChevronLeft size={14} /></button>
            {navTitle}
            <button type="button" className="date-picker-nav-button" aria-label={navNextLabel} onClick={navNext}><ChevronRight size={14} /></button>
          </div>
          {view === "day" && renderDayView()}
          {view === "month" && renderMonthView()}
          {view === "year" && renderYearView()}
        </div>
      )}
    </span>
  );
}
