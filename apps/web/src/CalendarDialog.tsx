import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  List,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { mailErrorMessage } from "./errorPresentation";
import { useI18n } from "./i18n";
import type { CalendarEvent, CalendarEventColor, CalendarEventInput } from "./types";
import { calendarEventColors } from "./types";
import DatePicker from "./DatePicker";
import { ManagementDialogShell } from "./ManagementDialogs";
import { useDialogFocus } from "./useDialogFocus";
import { useDismissTransition } from "./useDismissTransition";

type Notice = { kind: "success" | "error"; message: string } | null;

type EventDraft = {
  title: string;
  description: string;
  location: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  allDay: boolean;
  color: CalendarEventColor;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoToDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoToTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateTimeToIso(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

function dateToStartIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

function dateToEndIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

function draftFromEvent(event: CalendarEvent): EventDraft {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    startDate: isoToDate(event.startAt),
    startTime: isoToTime(event.startAt),
    endDate: isoToDate(event.endAt),
    endTime: isoToTime(event.endAt),
    allDay: event.allDay,
    color: event.color,
  };
}

/** Local dates (inclusive) covered by an event, so multi-day events render on every day. */
function eventDayKeys(event: CalendarEvent): string[] {
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const keys: string[] = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let guard = 0;
  while (cursor.getTime() <= endDay.getTime() && guard < 400) {
    keys.push(localDateKey(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    guard += 1;
  }
  return keys;
}

function emptyDraft(dayKey: string, now = new Date()): EventDraft {
  const date = new Date(`${dayKey}T12:00:00`);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), now.getHours(), 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    title: "",
    description: "",
    location: "",
    startDate: localDateKey(start),
    startTime: `${pad(start.getHours())}:00`,
    endDate: localDateKey(end),
    endTime: `${pad(end.getHours())}:00`,
    allDay: false,
    color: "blue",
  };
}

function demoCalendarEvents(now = new Date()): CalendarEvent[] {
  const iso = (offsetDays: number, hours: number, minutes = 0): string =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, hours, minutes, 0, 0).toISOString();
  const id = (index: number) => `demo-event-${index}`;
  return [
    {
      id: id(1),
      title: "晨会",
      description: "每日同步",
      location: "线上",
      startAt: iso(0, 9, 0),
      endAt: iso(0, 9, 30),
      allDay: false,
      color: "blue",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: id(2),
      title: "设计评审",
      description: "产品迭代设计稿评审",
      location: "会议室 A",
      startAt: iso(2, 14, 0),
      endAt: iso(2, 15, 30),
      allDay: false,
      color: "purple",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: id(3),
      title: "产品发布",
      description: "月度版本上线",
      location: "",
      startAt: iso(7, 0, 0),
      endAt: iso(7, 23, 59),
      allDay: true,
      color: "green",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: id(4),
      title: "团队建设",
      description: "季度团建",
      location: "郊野公园",
      startAt: iso(10, 0, 0),
      endAt: iso(11, 23, 59),
      allDay: true,
      color: "teal",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
}

export type CalendarDialogProps = {
  demoMode?: boolean;
  onClose: () => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
};

const MAX_EVENTS_PER_CELL = 3;
/** Events past this count unlock the search / pagination / bulk toolbar. */
const EVENTS_PER_PAGE = 5;

export default function CalendarDialog({ demoMode = false, onClose, fallbackFocusRef }: CalendarDialogProps) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const editorDialog = useRef<HTMLElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const jumpWrapRef = useRef<HTMLDivElement>(null);
  const [viewMonth, setViewMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [events, setEvents] = useState<CalendarEvent[]>(() => (demoMode ? demoCalendarEvents() : []));
  const [view, setView] = useState<"month" | "list">("month");
  const [listEvents, setListEvents] = useState<CalendarEvent[]>(() => (demoMode ? demoCalendarEvents() : []));
  const [loading, setLoading] = useState(!demoMode);
  const [listLoading, setListLoading] = useState(!demoMode);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ event: CalendarEvent | null; dayKey: string } | null>(null);
  // Validation/save errors shown inside the event editor modal, distinct from
  // the calendar page's global notice (which stays for save/delete success and
  // list-level bulk actions).
  const [editorError, setEditorError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EventDraft>(() => emptyDraft(localDateKey(new Date())));
  const [pendingDelete, setPendingDelete] = useState<CalendarEvent | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpYear, setJumpYear] = useState(() => new Date().getFullYear());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);

  const todayKey = localDateKey(new Date());

  // Load events spanning the visible month plus its neighbours so the grid has
  // data for the trailing days of the previous/next month as well.
  useEffect(() => {
    if (demoMode) return undefined;
    let active = true;
    setLoading(true);
    setLoadError(null);
    const rangeStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
    const rangeEnd = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 2, 0, 23, 59, 59, 999);
    void api.calendarEvents({ after: rangeStart.toISOString(), before: rangeEnd.toISOString() }).then((result) => {
      if (!active) return;
      setEvents(result.items);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [viewMonth, demoMode, loadAttempt]);

  // The event list spans every month, so it loads the full calendar.
  useEffect(() => {
    if (demoMode) {
      setListEvents(demoCalendarEvents());
      setListLoading(false);
      return undefined;
    }
    if (view !== "list") return undefined;
    let active = true;
    setListLoading(true);
    setLoadError(null);
    void api.calendarEvents().then((result) => {
      if (!active) return;
      setListEvents(result.items);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error);
    }).finally(() => {
      if (active) setListLoading(false);
    });
    return () => {
      active = false;
    };
  }, [view, demoMode, loadAttempt]);

  useDialogFocus(true, dialogRef, { fallbackFocusRef, suspended: Boolean(editor || pendingDelete || pendingBulkDelete) });
  useDialogFocus(Boolean(editor), editorDialog, { fallbackFocusRef: dialogRef });
  useDialogFocus(Boolean(pendingDelete || pendingBulkDelete), confirmationDialog, { fallbackFocusRef: dialogRef });
  const { closing, requestClose } = useDismissTransition(() => {
    onClose();
  });
  const { closing: editorClosing, requestClose: requestEditorClose, reset: resetEditorClosing } = useDismissTransition(() => setEditor(null));
  const { closing: confirmClosing, requestClose: requestConfirmClose, reset: resetConfirmClosing } = useDismissTransition(() => {
    setPendingDelete(null);
    setPendingBulkDelete(false);
  });

  const guardedRequestClose = () => {
    if (busy) return;
    requestClose();
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pendingDelete || pendingBulkDelete) {
        requestConfirmClose();
        return;
      }
      if (editor) {
        requestEditorClose();
        return;
      }
      if (jumpOpen) {
        setJumpOpen(false);
        return;
      }
      guardedRequestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  });

  // Close the month/year jump panel on any click outside it.
  useEffect(() => {
    if (!jumpOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (jumpWrapRef.current && !jumpWrapRef.current.contains(event.target as Node)) setJumpOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => window.removeEventListener("mousedown", closeOnOutsideClick);
  }, [jumpOpen]);

  const weekdayFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);
  const weekdays = useMemo(() => {
    const base = new Date(2026, 0, 5); // 2026-01-05 is a Monday.
    return Array.from({ length: 7 }, (_, index) => weekdayFormatter.format(new Date(base.getFullYear(), base.getMonth(), base.getDate() + index)));
  }, [weekdayFormatter]);

  const monthLabel = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" });
    return formatter.format(viewMonth);
  }, [locale, viewMonth]);

  const monthNames = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { month: "short" });
    return Array.from({ length: 12 }, (_, index) => formatter.format(new Date(2026, index, 1)));
  }, [locale]);

  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }), [locale]);

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }), [locale]);

  const formatEventWhen = (event: CalendarEvent): string => {
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);
    if (event.allDay) {
      const endText = isoToDate(event.startAt) === isoToDate(event.endAt) ? "" : ` – ${dateFormatter.format(end)}`;
      return `${dateFormatter.format(start)}${endText}`;
    }
    return `${dateTimeFormatter.format(start)} – ${dateTimeFormatter.format(end)}`;
  };

  const gridDays = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const firstWeekday = (first.getDay() + 6) % 7; // Monday = 0.
    const gridStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1 - firstWeekday);
    return Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
  }, [viewMonth]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      for (const key of eventDayKeys(event)) {
        const list = map.get(key);
        if (list) list.push(event);
        else map.set(key, [event]);
      }
    }
    return map;
  }, [events]);

  const sortedListEvents = useMemo(
    () => [...listEvents].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)),
    [listEvents],
  );

  const showListToolbar = sortedListEvents.length > EVENTS_PER_PAGE;

  const filteredListEvents = useMemo(() => {
    if (!showListToolbar || !searchQuery.trim()) return sortedListEvents;
    const needle = searchQuery.trim().toLocaleLowerCase();
    return sortedListEvents.filter((event) =>
      event.title.toLocaleLowerCase().includes(needle)
      || event.description.toLocaleLowerCase().includes(needle)
      || event.location.toLocaleLowerCase().includes(needle));
  }, [sortedListEvents, searchQuery, showListToolbar]);

  const listPageCount = Math.max(1, Math.ceil(filteredListEvents.length / EVENTS_PER_PAGE));
  const clampedListPage = Math.min(page, listPageCount);
  const pageListEvents = useMemo(() => {
    if (!showListToolbar) return filteredListEvents;
    const start = (clampedListPage - 1) * EVENTS_PER_PAGE;
    return filteredListEvents.slice(start, start + EVENTS_PER_PAGE);
  }, [filteredListEvents, showListToolbar, clampedListPage]);

  // Keep the page and selection valid after the event list changes.
  useEffect(() => {
    if (page > listPageCount) setPage(listPageCount);
  }, [page, listPageCount]);
  useEffect(() => {
    const valid = new Set(listEvents.map((event) => event.id));
    setSelectedIds((previous) => {
      let changed = false;
      const next = new Set(previous);
      for (const id of next) {
        if (!valid.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [listEvents]);

  const shiftMonth = (delta: number) => {
    setJumpOpen(false);
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1));
  };

  const openJumpPanel = () => {
    setJumpYear(viewMonth.getFullYear());
    setJumpOpen((open) => !open);
  };

  const shiftJumpYear = (delta: number) => setJumpYear((year) => year + delta);

  const pickJumpMonth = (monthIndex: number) => {
    setViewMonth(new Date(jumpYear, monthIndex, 1));
    setJumpOpen(false);
  };

  const openNewEvent = (dayKey: string) => {
    resetEditorClosing();
    setDraft(emptyDraft(dayKey));
    setEditor({ event: null, dayKey });
    setEditorError(null);
    setNotice(null);
  };

  const openEditEvent = (event: CalendarEvent) => {
    resetEditorClosing();
    setDraft(draftFromEvent(event));
    setEditor({ event, dayKey: isoToDate(event.startAt) });
    setEditorError(null);
    setNotice(null);
  };

  const saveDraft = async () => {
    if (!editor || busy) return;
    const title = draft.title.trim();
    if (!title) {
      setEditorError(t("calendar.validation.titleRequired"));
      return;
    }
    let startIso: string;
    let endIso: string;
    try {
      startIso = draft.allDay ? dateToStartIso(draft.startDate) : dateTimeToIso(draft.startDate, draft.startTime);
      endIso = draft.allDay ? dateToEndIso(draft.endDate) : dateTimeToIso(draft.endDate, draft.endTime);
    } catch {
      setEditorError(t("calendar.validation.invalidDates"));
      return;
    }
    if (Date.parse(endIso) < Date.parse(startIso)) {
      setEditorError(t("calendar.validation.endBeforeStart"));
      return;
    }
    const input: CalendarEventInput = {
      title,
      description: draft.description.trim(),
      location: draft.location.trim(),
      startAt: startIso,
      endAt: endIso,
      allDay: draft.allDay,
      color: draft.color,
    };
    setBusy(true);
    setEditorError(null);
    try {
      if (demoMode) {
        if (editor.event) {
          const updated: CalendarEvent = { ...editor.event, ...input, updatedAt: new Date().toISOString() };
          setEvents((current) => current.map((event) => event.id === updated.id ? updated : event));
          setListEvents((current) => current.map((event) => event.id === updated.id ? updated : event));
        } else {
          const created: CalendarEvent = {
            id: `demo-event-${Date.now()}`,
            title: input.title,
            description: input.description ?? "",
            location: input.location ?? "",
            startAt: input.startAt,
            endAt: input.endAt,
            allDay: input.allDay ?? false,
            color: input.color ?? "blue",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          setEvents((current) => [...current, created]);
          setListEvents((current) => [...current, created]);
        }
        setEditor(null);
        setNotice({ kind: "success", message: t("calendar.saved") });
        return;
      }
      if (editor.event) {
        const result = await api.updateCalendarEvent(editor.event.id, input);
        setEvents((current) => current.map((event) => event.id === result.event.id ? result.event : event));
        setListEvents((current) => current.map((event) => event.id === result.event.id ? result.event : event));
      } else {
        const result = await api.createCalendarEvent(input);
        setEvents((current) => [...current, result.event]);
        setListEvents((current) => [...current, result.event]);
      }
      setEditor(null);
      setNotice({ kind: "success", message: t("calendar.saved") });
    } catch (error) {
      // Keep the editor open and surface the failure inside it.
      setEditorError(mailErrorMessage(error, t("calendar.saveFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async () => {
    if (!pendingDelete || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (!demoMode) await api.deleteCalendarEvent(pendingDelete.id);
      setEvents((current) => current.filter((event) => event.id !== pendingDelete.id));
      setListEvents((current) => current.filter((event) => event.id !== pendingDelete.id));
      setPendingDelete(null);
      setEditor(null);
      setNotice({ kind: "success", message: t("calendar.deleted") });
    } catch (error) {
      // The editor stays open; show the failure inside it instead of the page.
      setEditorError(mailErrorMessage(error, t("calendar.deleteFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (busy) return;
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusy(true);
    setNotice(null);
    let removed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        if (!demoMode) await api.deleteCalendarEvent(id);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    setEvents((current) => current.filter((event) => !selectedIds.has(event.id)));
    setListEvents((current) => current.filter((event) => !selectedIds.has(event.id)));
    setPendingBulkDelete(false);
    setSelectedIds(new Set());
    if (failed) {
      setNotice({ kind: "error", message: t("calendar.bulkDeletedPartial", { removed, failed }) });
    } else {
      setNotice({ kind: "success", message: t("calendar.bulkDeleted", { count: removed }) });
    }
    setBusy(false);
  };

  const toggleSelect = (eventId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const allListPageSelected = showListToolbar && pageListEvents.length > 0 && pageListEvents.every((event) => selectedIds.has(event.id));

  const toggleAllListPage = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allListPageSelected) {
        for (const event of pageListEvents) next.delete(event.id);
      } else {
        for (const event of pageListEvents) next.add(event.id);
      }
      return next;
    });
  };

  const renderEventChip = (event: CalendarEvent) => (
    <button
      key={event.id}
      type="button"
      className={`calendar-chip calendar-chip-${event.color}${event.allDay ? " all-day" : ""}`}
      onClick={(click) => {
        click.stopPropagation();
        openEditEvent(event);
      }}
      title={event.title}
    >
      {!event.allDay && <Clock size={10} aria-hidden="true" />}
      <span>{event.title}</span>
    </button>
  );

  return (
    <>
      <ManagementDialogShell
        titleId="calendar-dialog-title"
        eyebrow={t("navigation.management")}
        title={t("calendar.title")}
        description={demoMode ? t("calendar.demoDescription") : t("calendar.description")}
        onClose={guardedRequestClose}
        closing={closing}
        requestClose={guardedRequestClose}
        fallbackFocusRef={fallbackFocusRef}
        dialogRef={dialogRef}
      >
        <section className="settings-section calendar-section">
          {notice && (
            <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
              {notice.kind === "success" ? <Check size={17} /> : <X size={17} />}
              {notice.message}
            </div>
          )}
          {view === "month" ? (
            <>
              <div className="calendar-toolbar-wrap" ref={jumpWrapRef}>
                <div className="calendar-toolbar">
                  <button className="secondary-button calendar-nav" type="button" aria-label={t("calendar.previousMonth")} data-tooltip={t("calendar.previousMonth")} onClick={() => shiftMonth(-1)}><ChevronLeft size={15} /></button>
                  <button
                    type="button"
                    className="calendar-month-label"
                    aria-label={t("calendar.monthLabelAriaLabel")}
                    aria-expanded={jumpOpen}
                    onClick={openJumpPanel}
                  >
                    {monthLabel}<ChevronDown size={13} aria-hidden="true" />
                  </button>
                  <button className="secondary-button calendar-nav" type="button" aria-label={t("calendar.nextMonth")} data-tooltip={t("calendar.nextMonth")} onClick={() => shiftMonth(1)}><ChevronRight size={15} /></button>
                  <button className="secondary-button calendar-today" type="button" onClick={() => { setJumpOpen(false); setViewMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); }}>{t("calendar.today")}</button>
                  <button className="secondary-button calendar-view-switch" type="button" onClick={() => setView("list")}>
                    <List size={14} />{t("calendar.eventsList")}
                  </button>
                </div>
                {jumpOpen && (
                  <div className="calendar-jump-panel" role="dialog" aria-label={t("calendar.jumpPanelAriaLabel")}>
                    <div className="calendar-jump-year">
                      <button className="secondary-button calendar-jump-year-nav" type="button" aria-label={t("calendar.jumpYearPrevious")} data-tooltip={t("calendar.jumpYearPrevious")} onClick={() => shiftJumpYear(-1)}><ChevronLeft size={14} /></button>
                      <strong>{jumpYear}</strong>
                      <button className="secondary-button calendar-jump-year-nav" type="button" aria-label={t("calendar.jumpYearNext")} data-tooltip={t("calendar.jumpYearNext")} onClick={() => shiftJumpYear(1)}><ChevronRight size={14} /></button>
                    </div>
                    <div className="calendar-jump-months">
                      {monthNames.map((month, index) => {
                        const selected = index === viewMonth.getMonth() && jumpYear === viewMonth.getFullYear();
                        return (
                          <button
                            key={month}
                            type="button"
                            className={`calendar-jump-month${selected ? " selected" : ""}`}
                            aria-label={t("calendar.jumpMonthAriaLabel", { month, year: jumpYear })}
                            onClick={() => pickJumpMonth(index)}
                          >
                            {month}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              {loading ? (
                <p className="settings-empty calendar-loading"><LoaderCircle className="spin" size={14} />{t("calendar.loading")}</p>
              ) : loadError ? (
                <p className="settings-empty calendar-load-error" role="alert">{t("calendar.loadError")}</p>
              ) : (
                <div className="calendar-grid">
                  {weekdays.map((weekday, index) => (
                    <div className="calendar-weekday" key={index}>{weekday}</div>
                  ))}
                  {gridDays.map((day) => {
                    const key = localDateKey(day);
                    const inCurrentMonth = day.getMonth() === viewMonth.getMonth();
                    const isToday = key === todayKey;
                    const dayEvents = eventsByDay.get(key) ?? [];
                    const visible = dayEvents.slice(0, MAX_EVENTS_PER_CELL);
                    const hidden = dayEvents.length - visible.length;
                    return (
                      <div
                        key={key}
                        className={`calendar-day${inCurrentMonth ? "" : " outside"}${isToday ? " today" : ""}${dayEvents.length ? " has-events" : ""}`}
                        aria-label={key}
                        onClick={() => openNewEvent(key)}
                      >
                        <button
                          type="button"
                          className="calendar-day-number"
                          aria-label={t("calendar.addOnDay", { date: key })}
                          data-tooltip={t("calendar.addOnDayTooltip")}
                          onClick={(click) => {
                            click.stopPropagation();
                            openNewEvent(key);
                          }}
                        >
                          {day.getDate()}
                        </button>
                        <div className="calendar-day-events">
                          {visible.map(renderEventChip)}
                          {hidden > 0 && <span className="calendar-more">{t("calendar.moreEvents", { count: hidden })}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="calendar-toolbar">
                <button className="secondary-button" type="button" onClick={() => openNewEvent(localDateKey(new Date()))}>
                  <Plus size={14} />{t("calendar.newEvent")}
                </button>
                <strong className="calendar-list-title">{t("calendar.eventsList")}</strong>
                <button className="secondary-button calendar-view-switch" type="button" onClick={() => setView("month")}>
                  <CalendarDays size={14} />{t("calendar.monthView")}
                </button>
              </div>
              {listLoading ? (
                <p className="settings-empty calendar-loading"><LoaderCircle className="spin" size={14} />{t("calendar.loading")}</p>
              ) : loadError ? (
                <p className="settings-empty calendar-load-error" role="alert">{t("calendar.loadError")}</p>
              ) : sortedListEvents.length === 0 ? (
                <p className="settings-empty">{t("calendar.listEmpty")}</p>
              ) : (
                <>
                  {showListToolbar && (
                    <div className="calendar-list-toolbar">
                      <div className="search-wrap calendar-list-search">
                        <Search size={14} aria-hidden="true" />
                        <input
                          type="search"
                          value={searchQuery}
                          onChange={(event) => {
                            setSearchQuery(event.target.value);
                            setPage(1);
                          }}
                          placeholder={t("calendar.searchPlaceholder")}
                          aria-label={t("calendar.searchAriaLabel")}
                        />
                        {searchQuery && (
                          <button className="icon-button search-clear" type="button" aria-label={t("calendar.clearSearch")} onClick={() => setSearchQuery("")}>
                            <X size={14} />
                          </button>
                        )}
                      </div>
                      {selectedIds.size > 0 ? (
                        <div className="calendar-list-bulk-actions">
                          <span className="calendar-list-bulk-count">{t("calendar.selectedCount", { count: selectedIds.size })}</span>
                          <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => { resetConfirmClosing(); setPendingBulkDelete(true); }}>
                            {busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{t("calendar.bulkDelete")}
                          </button>
                          <button className="secondary-button calendar-list-bulk-clear" type="button" disabled={busy} onClick={() => setSelectedIds(new Set())}>
                            {t("calendar.clearSelection")}
                          </button>
                        </div>
                      ) : (
                        <label className="calendar-list-select-all">
                          <input type="checkbox" checked={allListPageSelected} onChange={toggleAllListPage} aria-label={t("calendar.selectAllAriaLabel")} />
                          {t("calendar.selectAll")}
                        </label>
                      )}
                    </div>
                  )}
                  {filteredListEvents.length === 0 ? (
                    <p className="settings-empty">{t("calendar.noSearchResults")}</p>
                  ) : (
                    <>
                      <div className="calendar-list">
                        {pageListEvents.map((event) => {
                          const selected = selectedIds.has(event.id);
                          return (
                            <div className={`calendar-list-row${selected ? " selected" : ""}`} key={event.id}>
                              <div className="calendar-list-row-main">
                                {showListToolbar && (
                                  <label className="calendar-list-row-check">
                                    <input type="checkbox" checked={selected} onChange={() => toggleSelect(event.id)} aria-label={t("calendar.selectAriaLabel", { title: event.title })} />
                                  </label>
                                )}
                                <span className={`calendar-list-color calendar-list-color-${event.color}`} aria-hidden="true" />
                                <div className="calendar-list-copy">
                                  <strong>{event.title}</strong>
                                  <small><Clock size={10} />{formatEventWhen(event)}</small>
                                  {event.location && <small className="calendar-list-location"><MapPin size={10} />{event.location}</small>}
                                  {event.description && <small className="calendar-list-description">{event.description}</small>}
                                </div>
                                <div className="calendar-list-actions">
                                  <button className="secondary-button" type="button" disabled={busy} onClick={() => openEditEvent(event)}>
                                    <Pencil size={15} />{t("calendar.editEvent")}
                                  </button>
                                  <button className="icon-button danger-icon-button" type="button" aria-label={t("calendar.deleteAriaLabel", { title: event.title })} data-tooltip={t("calendar.delete")} disabled={busy} onClick={() => { resetConfirmClosing(); setPendingDelete(event); }}>
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {showListToolbar && listPageCount > 1 && (
                        <div className="calendar-list-pager">
                          <button className="secondary-button" type="button" disabled={busy || clampedListPage <= 1} onClick={() => setPage(clampedListPage - 1)} aria-label={t("calendar.pagerPrevious")}>
                            <ChevronLeft size={15} />{t("calendar.pagerPrevious")}
                          </button>
                          <span className="calendar-list-pager-status" role="status">{t("calendar.pagerLabel", { page: clampedListPage, total: listPageCount })}</span>
                          <button className="secondary-button" type="button" disabled={busy || clampedListPage >= listPageCount} onClick={() => setPage(clampedListPage + 1)} aria-label={t("calendar.pagerNext")}>
                            {t("calendar.pagerNext")}<ChevronRight size={15} />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </ManagementDialogShell>
      {editor && (
        <div className={`modal-backdrop calendar-editor-backdrop${editorClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && requestEditorClose()}>
          <section ref={editorDialog} className={`calendar-editor-modal${editorClosing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label={editor.event ? t("calendar.editEvent") : t("calendar.newEvent")} tabIndex={-1}>
            <div className="calendar-editor" role="form" aria-label={t("calendar.formAriaLabel")}>
              <div className="calendar-editor-head">
                <span className="eyebrow">{editor.event ? t("calendar.editEvent") : t("calendar.newEvent")}</span>
                {editor.event && (
                  <button className="icon-button danger-icon-button" type="button" aria-label={t("calendar.delete")} data-tooltip={t("calendar.delete")} disabled={busy} onClick={() => { resetConfirmClosing(); setPendingDelete(editor.event); }}>
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {editorError && (
                <div className="calendar-editor-error" role="alert"><CircleAlert size={14} /><span>{editorError}</span></div>
              )}
              <label className="calendar-field">
                <span>{t("calendar.titleLabel")}</span>
                <input type="text" maxLength={300} value={draft.title} onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} placeholder={t("calendar.titlePlaceholder")} autoFocus />
              </label>
              <label className="calendar-field calendar-check">
                <input type="checkbox" checked={draft.allDay} onChange={(event) => setDraft((value) => ({ ...value, allDay: event.target.checked }))} />
                <span>{t("calendar.allDay")}</span>
              </label>
              <div className="calendar-field-grid">
                <label className="calendar-field">
                  <span>{t("calendar.start")}</span>
                  {draft.allDay
                    ? <DatePicker mode="date" value={draft.startDate} aria-label={t("calendar.start")} onChange={(value) => setDraft((draftValue) => ({ ...draftValue, startDate: value }))} />
                    : <DatePicker mode="datetime" value={`${draft.startDate}T${draft.startTime}`} aria-label={t("calendar.start")} onChange={(value) => {
                        const [date, time = "00:00"] = value.split("T");
                        setDraft((draftValue) => ({ ...draftValue, startDate: date, startTime: time }));
                      }} />}
                </label>
                <label className="calendar-field">
                  <span>{t("calendar.end")}</span>
                  {draft.allDay
                    ? <DatePicker mode="date" value={draft.endDate} aria-label={t("calendar.end")} onChange={(value) => setDraft((draftValue) => ({ ...draftValue, endDate: value }))} />
                    : <DatePicker mode="datetime" value={`${draft.endDate}T${draft.endTime}`} aria-label={t("calendar.end")} onChange={(value) => {
                        const [date, time = "00:00"] = value.split("T");
                        setDraft((draftValue) => ({ ...draftValue, endDate: date, endTime: time }));
                      }} />}
                </label>
              </div>
              <label className="calendar-field">
                <span><MapPin size={13} />{t("calendar.location")}</span>
                <input type="text" maxLength={500} value={draft.location} onChange={(event) => setDraft((value) => ({ ...value, location: event.target.value }))} placeholder={t("calendar.locationPlaceholder")} />
              </label>
              <label className="calendar-field">
                <span>{t("calendar.description")}</span>
                <textarea rows={3} maxLength={10000} value={draft.description} onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))} placeholder={t("calendar.descriptionPlaceholder")} />
              </label>
              <div className="calendar-field" role="radiogroup" aria-label={t("calendar.color")}>
                <span>{t("calendar.color")}</span>
                <div className="calendar-color-row">
                  {calendarEventColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={draft.color === color}
                      className={`calendar-color-swatch calendar-color-${color}${draft.color === color ? " selected" : ""}`}
                      aria-label={t(`calendar.color.${color}`)}
                      onClick={() => setDraft((value) => ({ ...value, color }))}
                    />
                  ))}
                </div>
              </div>
              <div className="calendar-editor-actions">
                <button className="secondary-button" type="button" disabled={busy} onClick={requestEditorClose}>{t("common.cancel")}</button>
                <button className="primary-button" type="button" disabled={busy} onClick={() => void saveDraft()}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t("calendar.save")}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {(pendingDelete || pendingBulkDelete) && (
        <div className={`modal-backdrop confirmation-backdrop${confirmClosing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && requestConfirmClose()}>
          <section ref={confirmationDialog} className={`confirmation-card${confirmClosing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="calendar-confirmation-title" aria-describedby="calendar-confirmation-description" tabIndex={-1}>
            <span className="eyebrow">{t("settings.confirmation.eyebrow")}</span>
            {pendingDelete ? (
              <>
                <h3 id="calendar-confirmation-title">{t("calendar.deleteConfirmTitle")}</h3>
                <p id="calendar-confirmation-description">{t("calendar.deleteConfirmDescription", { title: pendingDelete.title })}</p>
                <div className="confirmation-actions">
                  <button className="secondary-button" type="button" data-dialog-initial-focus disabled={busy} onClick={requestConfirmClose}>{t("common.cancel")}</button>
                  <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => void deleteEvent()}>
                    {busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("calendar.deleteConfirmAction")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 id="calendar-confirmation-title">{t("calendar.bulkDeleteTitle", { count: selectedIds.size })}</h3>
                <p id="calendar-confirmation-description">{t("calendar.bulkDeleteDescription")}</p>
                <div className="confirmation-actions">
                  <button className="secondary-button" type="button" data-dialog-initial-focus disabled={busy} onClick={requestConfirmClose}>{t("common.cancel")}</button>
                  <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => void removeSelected()}>
                    {busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("calendar.bulkDeleteAction")}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}