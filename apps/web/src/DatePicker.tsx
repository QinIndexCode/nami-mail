import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { buildGrid, chunkRows, dateKey, pad, parseTime, parseValue, timeValue } from "./datePickerUtils";
import { usePopupExitTransition } from "./hooks/usePopupExitTransition";
import { registerDialogPortal } from "./hooks/useDialogFocus";
import ThemedSelect from "./ThemedSelect";
import { useI18n } from "./i18n";

export type DatePickerMode = "date" | "datetime";

/**
 * The dialog whose focus trap owns this panel, if any. The panel is portaled to
 * document.body either way, because every dialog card clips its overflow and
 * two of them are scroll containers — an in-dialog `position: absolute` panel
 * is cut off, and inside a scroller it rides the content. Escaping that means
 * leaving the dialog subtree, which is why the element is needed: it registers
 * the panel with the trap so a day button taking focus is not yanked straight
 * back out (see registerDialogPortal). A ref is accepted so callers can hand
 * over their dialog ref directly: it is dereferenced during this component's
 * own render, which is always after the dialog element has been attached.
 */
type PanelHost = HTMLElement | RefObject<HTMLElement | null> | null | undefined;

function resolvePanelHost(host: PanelHost): HTMLElement | null {
  if (!host) return null;
  return "current" in host ? host.current : host;
}

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
  /**
   * Element the panel is logically owned by: the dialog whose focus trap must
   * admit it. Callers inside a focus-trapped dialog must pass one (usually the
   * dialog element itself) — a panel on document.body sits outside the trap and
   * the trap yanks focus back the moment a day button takes it. Omit it outside
   * dialogs, where the body portal is both the correct and the unclipped
   * placement.
   */
  panelHost?: PanelHost;
};

type PanelView = "day" | "month" | "year";

const MONTHS_PER_YEAR = 12;
/** Column counts per view; they also drive the arrow-key row stride. */
const DAY_COLUMNS = 7;
const MONTH_COLUMNS = 4;
const YEAR_COLUMNS = 4;

/**
 * Which day the day grid should focus when it needs an entry point.
 *
 * Preference order: the selected day, then today, then the first selectable
 * day. Every candidate is checked against the grid actually being rendered —
 * the selected day routinely lives in another month (that is the whole point
 * of the nav arrows), and focusing a key no cell carries would leave the grid
 * with zero `tabIndex=0` cells, unreachable by keyboard.
 */
function dayEntryKey(
  gridDays: Date[],
  selectedKey: string,
  todayKey: string,
  minDate: string | undefined,
  maxDate: string | undefined,
): string {
  const selectable = gridDays.filter((day) => {
    const key = dateKey(day);
    if (minDate && key < minDate) return false;
    if (maxDate && key > maxDate) return false;
    return true;
  });
  const preferred = [selectedKey, todayKey].find((key) => key && selectable.some((day) => dateKey(day) === key));
  return preferred ?? (selectable[0] ? dateKey(selectable[0]) : "");
}

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
  panelHost,
}: DatePickerProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const { mounted: panelMounted, closing: panelClosing, beginClose: beginPanelClose } = usePopupExitTransition(open, () => setOpen(false));
  const [view, setView] = useState<PanelView>("day");
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const base = parseValue(value, mode).date ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [focusedMonth, setFocusedMonth] = useState<number | null>(null);
  const [focusedYear, setFocusedYear] = useState<number | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const parsed = useMemo(() => parseValue(value, mode), [value, mode]);
  const { hour, minute } = useMemo(() => parseTime(parsed.time), [parsed.time]);
  const todayKey = useMemo(() => dateKey(new Date()), []);
  const selectedKey = parsed.date ? dateKey(parsed.date) : "";
  // The dialog whose focus trap owns the panel. The panel itself always lands on
  // document.body (see the portal below), because an in-dialog panel is clipped
  // by the card's overflow — and `overflow: visible` is not an option, since
  // two of the three hosts are the dialog's own scroll container.
  const hostElement = resolvePanelHost(panelHost);
  const hosted = hostElement !== null;

  // The panel lives outside the dialog subtree, so the trap would treat focus in
  // it as an escape and yank it straight back to the dialog. Registering it
  // makes the trap's scope "this dialog plus the popups it owns" instead of
  // "this dialog's descendants", which is what the panel has always been.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !hosted || !hostElement || !panel) return undefined;
    return registerDialogPortal(hostElement, panel);
  }, [open, hosted, hostElement]);

  // Floating-UI owns placement in both cases: flip picks the side with room,
  // shift keeps the panel inside the viewport, and autoUpdate repositions across
  // scrolling, resizing, and view changes. `fixed` is correct for the body
  // portal: the panel has no transformed ancestor, so its containing block is
  // the viewport, and shift's default `clippingAncestors` boundary then resolves
  // to the viewport too — not to the dialog card the panel is logically owned by.
  useEffect(() => {
    if (!open) return undefined;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return undefined;
    const update = () => {
      void computePosition(trigger, panel, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
      });
    };
    update();
    return autoUpdate(trigger, panel, update);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The panel is portaled out of the trigger wrapper, so the outside-click
      // check must cover it explicitly.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      beginPanelClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open, beginPanelClose]);

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
  const viewMonthMonth = viewMonth.getMonth();

  // Year view shows a rolling 12-year window centred on the viewed year.
  const yearWindowStart = year - 5;
  const yearCells = useMemo(
    () => Array.from({ length: MONTHS_PER_YEAR }, (_, index) => ({ year: yearWindowStart + index })),
    [yearWindowStart],
  );
  const monthCells = useMemo(() => Array.from({ length: MONTHS_PER_YEAR }, (_, index) => index), []);

  const inRange = (day: Date): boolean => {
    const key = dateKey(day);
    if (minDate && key < minDate) return false;
    if (maxDate && key > maxDate) return false;
    return true;
  };

  // Day view entry point. Deliberately NOT keyed on the viewed month: arrowing
  // across a month boundary changes the viewed month *because* the focus moved,
  // so re-seeding here would snap focus back to the selected day — which is not
  // even rendered in the new grid, leaving every cell at tabIndex -1 and the
  // grid with no roving-tabindex entry point at all. The paths that change the
  // month without moving the focus (the nav arrows, picking a month) carry the
  // focused day across themselves — see carryDayIntoMonth.
  useEffect(() => {
    if (!open || view !== "day") return;
    setFocusedKey(dayEntryKey(gridDays, selectedKey, todayKey, minDate, maxDate));
    // gridDays is read through the helper's argument, not closed over, so the
    // month it is derived from cannot become a re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, selectedKey, todayKey, minDate, maxDate]);

  // The month and year views focus the viewed period itself, so these two DO
  // follow the viewed month/year: the year grid is a rolling window around it,
  // and a stale focusedYear would fall outside the window with no focused cell.
  useEffect(() => {
    if (!open) return;
    if (view === "month") setFocusedMonth(viewMonthMonth);
    if (view === "year") setFocusedYear(year);
  }, [open, view, viewMonthMonth, year]);

  /** Focus key of the same day-of-month in `month`, clamped to its length so a
   *  31st never lands on a nonexistent February 31st. */
  const carryDayIntoMonth = (month: Date): string => {
    const current = gridDays.find((day) => dateKey(day) === focusedKey)?.getDate() ?? 1;
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return dateKey(new Date(month.getFullYear(), month.getMonth(), Math.min(current, lastDay)));
  };

  const displayValue = useMemo(() => {
    if (!parsed.date) return "";
    const dateFormatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
    const dateText = dateFormatter.format(parsed.date);
    return mode === "datetime" ? `${dateText} ${parsed.time}` : dateText;
  }, [locale, mode, parsed]);

  const hours = useMemo(() => Array.from({ length: 24 }, (_, index) => pad(index)), []);
  const minutes = useMemo(() => Array.from({ length: 12 }, (_, index) => pad(index * 5)), []);

  const emitValue = (day: Date) => {
    const nextDate = dateKey(day);
    if (!inRange(day)) return;
    onChange(mode === "datetime" ? `${nextDate}T${parsed.time}` : nextDate);
  };

  const pickDate = (day: Date) => {
    emitValue(day);
    if (mode === "date") beginPanelClose();
  };

  const pickTime = (nextTime: string) => {
    const nextDate = dateKey(parsed.date ?? new Date());
    onChange(`${nextDate}T${nextTime}`);
  };

  // The nav arrows move the month without moving the focus, so the day grid
  // would be left with no focused cell at all. Carry the same day-of-month
  // across — clamped, so stepping 31 Jan → Feb lands on the 28th/29th.
  const shiftViewMonth = (delta: number) => {
    const next = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1);
    setViewMonth(next);
    if (view === "day") setFocusedKey(carryDayIntoMonth(next));
  };

  const shiftViewYear = (delta: number) => {
    setViewMonth((current) => new Date(current.getFullYear() + delta, current.getMonth(), 1));
  };

  // Same reason as shiftViewMonth: returning from the month/year views lands on
  // a day grid that has not been focused yet.
  const selectMonth = (monthIndex: number) => {
    const next = new Date(viewMonth.getFullYear(), monthIndex, 1);
    setViewMonth(next);
    setFocusedKey(carryDayIntoMonth(next));
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
    if (mode === "date") beginPanelClose();
  };

  const toggle = () => {
    if (disabled) return;
    if (open) {
      beginPanelClose();
      return;
    }
    setOpen(true);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") beginPanelClose();
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const NAVIGATION_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "] as const;

  /**
   * Roving-focus keyboard handling shared by all three grids. Moving is a pure
   * index step over the view's cell list (rows are `columns` wide), so the day,
   * month and year views navigate identically instead of the day view being the
   * only keyboard-reachable one.
   */
  const handleGridKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    cells: { length: number },
    columns: number,
    currentIndex: number,
    moveTo: (index: number) => void,
    activate: (index: number) => void,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      beginPanelClose();
      return;
    }
    if (!(NAVIGATION_KEYS as readonly string[]).includes(event.key)) return;
    if (currentIndex < 0) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(currentIndex);
      return;
    }
    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") nextIndex = currentIndex - 1;
    if (event.key === "ArrowRight") nextIndex = currentIndex + 1;
    if (event.key === "ArrowUp") nextIndex = currentIndex - columns;
    if (event.key === "ArrowDown") nextIndex = currentIndex + columns;
    if (nextIndex < 0 || nextIndex >= cells.length) return;
    moveTo(nextIndex);
  };

  /** Roving focus must never rest on a cell the user cannot pick: a `disabled`
   *  button is skipped by Tab and refuses focus, so a focused one is both a lie
   *  and a dead end. Day cells are the only grid that can be disabled, so an
   *  arrow step that lands on one keeps walking in the SAME direction — by a
   *  row for Up/Down, so the column the reader chose is preserved. */
  const moveToEnabledDay = (fromIndex: number, step: number) => {
    for (let index = fromIndex; index >= 0 && index < gridDays.length; index += step) {
      if (inRange(gridDays[index])) {
        const nextDay = gridDays[index];
        setFocusedKey(dateKey(nextDay));
        // Keep the view in sync when the focus crosses a month boundary.
        setViewMonth(new Date(nextDay.getFullYear(), nextDay.getMonth(), 1));
        return;
      }
    }
  };

  const DAY_ARROW_STEP: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -DAY_COLUMNS,
    ArrowDown: DAY_COLUMNS,
  };

  const handleDayGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    handleGridKeyDown(
      event,
      gridDays,
      DAY_COLUMNS,
      gridDays.findIndex((day) => dateKey(day) === focusedKey),
      // `index` is the cell the arrow lands on; step from there in the same
      // direction so a disabled cell is stepped over rather than focused.
      (index) => moveToEnabledDay(index, DAY_ARROW_STEP[event.key]),
      (index) => pickDate(gridDays[index]),
    );
  };

  const handleMonthGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    handleGridKeyDown(
      event,
      monthCells,
      MONTH_COLUMNS,
      focusedMonth ?? -1,
      (index) => setFocusedMonth(index),
      (index) => selectMonth(index),
    );
  };

  const handleYearGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    handleGridKeyDown(
      event,
      yearCells,
      YEAR_COLUMNS,
      focusedYear === null ? -1 : yearCells.findIndex((cell) => cell.year === focusedYear),
      (index) => setFocusedYear(yearCells[index].year),
      (index) => selectYear(yearCells[index].year),
    );
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
      // A disabled cell must never hold the roving tabindex: the browser skips
      // it, so the grid would have no tabbable cell left at all.
      tabIndex: isFocused && !isDisabled ? 0 : -1,
      "aria-label": new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(day),
      "aria-selected": isSelected,
      onClick: () => pickDate(day),
      onFocus: () => {
        if (inRange(day)) setFocusedKey(key);
      },
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
      <div className="date-picker-grid" role="grid" aria-label={monthLabel} onKeyDown={handleDayGridKeyDown}>
        {chunkRows(gridDays, DAY_COLUMNS).map((row) => (
          <div className="date-picker-grid-row" role="row" key={dateKey(row[0])}>
            {row.map((day) => <button key={dateKey(day)} {...gridDayProps(day)}>{day.getDate()}</button>)}
          </div>
        ))}
      </div>
      {mode === "datetime" && (
        <div className="date-picker-time">
          <span className="date-picker-time-label">{t("datePicker.time")}</span>
          <span className="date-picker-time-segments">
            <ThemedSelect id={`${panelId}-hours`} className="date-picker-select" value={hour} aria-label={t("datePicker.hours")} onValueChange={(next) => pickTime(timeValue(next, minute))}>
              {hours.map((value) => <option key={value} value={value}>{value}</option>)}
            </ThemedSelect>
            <span aria-hidden="true">:</span>
            <ThemedSelect id={`${panelId}-minutes`} className="date-picker-select" value={minute} aria-label={t("datePicker.minutes")} onValueChange={(next) => pickTime(timeValue(hour, next))}>
              {minutes.map((value) => <option key={value} value={value}>{value}</option>)}
            </ThemedSelect>
          </span>
        </div>
      )}
      <button type="button" className="date-picker-today" onClick={jumpToToday}><CalendarDays size={12} aria-hidden="true" />{t("datePicker.today")}</button>
    </>
  );

  const renderMonthView = () => (
    <div className="date-picker-months" role="grid" aria-label={t("datePicker.chooseMonth")} onKeyDown={handleMonthGridKeyDown}>
      {chunkRows(monthCells, MONTH_COLUMNS).map((row) => (
        <div className="date-picker-grid-row" role="row" key={row[0]}>
          {row.map((index) => {
            const isCurrent = new Date().getMonth() === index && year === new Date().getFullYear();
            const isFocused = focusedMonth === index;
            return (
              <button
                key={index}
                type="button"
                role="gridcell"
                className={`date-picker-month${isCurrent ? " today" : ""}${isFocused ? " focused" : ""}`}
                tabIndex={isFocused ? 0 : -1}
                aria-selected={isFocused}
                aria-label={monthLongFormatter.format(new Date(year, index, 1))}
                onFocus={() => setFocusedMonth(index)}
                onClick={() => selectMonth(index)}
              >
                {monthFormatter.format(new Date(2000, index, 1))}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  const renderYearView = () => (
    <div className="date-picker-years" role="grid" aria-label={t("datePicker.chooseYear")} onKeyDown={handleYearGridKeyDown}>
      {chunkRows(yearCells, YEAR_COLUMNS).map((row) => (
        <div className="date-picker-grid-row" role="row" key={row[0].year}>
          {row.map(({ year: yearValue }) => {
            const isCurrent = yearValue === new Date().getFullYear();
            const isFocused = focusedYear === yearValue;
            return (
              <button
                key={yearValue}
                type="button"
                role="gridcell"
                className={`date-picker-year${isCurrent ? " today" : ""}${isFocused ? " focused" : ""}`}
                tabIndex={isFocused ? 0 : -1}
                aria-selected={isFocused}
                onFocus={() => setFocusedYear(yearValue)}
                onClick={() => selectYear(yearValue)}
              >
                {yearValue}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    <span ref={rootRef} className={`date-picker${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
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
      {panelMounted && createPortal(
        <div
          id={panelId}
          ref={panelRef}
          className={`date-picker-panel${panelClosing ? " closing" : ""}`}
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
        </div>,
        // Always document.body. A panel inside the dialog is clipped by the
        // card's overflow (hidden on the compose card, a scroll container on
        // the other two), and no amount of positioning escapes that — only
        // leaving the subtree does. panelHost then re-associates the panel
        // with the dialog's focus trap, which is what actually needed it there.
        document.body,
      )}
    </span>
  );
}
