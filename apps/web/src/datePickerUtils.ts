export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` key from a local date. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseTime(time: string): { hour: string; minute: string } {
  const [hour = "09", minute = "00"] = String(time).split(":");
  return { hour, minute };
}

export function timeValue(hour: string, minute: string): string {
  return `${pad(Number(hour))}:${pad(Number(minute))}`;
}

export function parseValue(value: string, mode: "date" | "datetime"): { date: Date | null; time: string } {
  if (!value) return { date: null, time: "09:00" };
  const datePart = value.slice(0, 10);
  const timePart = mode === "datetime" ? value.slice(11, 16) || "09:00" : "09:00";
  const parsed = new Date(`${datePart}T12:00:00`);
  return { date: Number.isFinite(parsed.getTime()) ? parsed : null, time: timePart };
}

/** 42-cell grid for the displayed month, always starting on a Monday. */
export function buildGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const firstWeekday = (first.getDay() + 6) % 7;
  const gridStart = new Date(month.getFullYear(), month.getMonth(), 1 - firstWeekday);
  return Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
}

/** Shift a local date by the given number of days. */
export function shiftDays(day: Date, delta: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + delta);
}
