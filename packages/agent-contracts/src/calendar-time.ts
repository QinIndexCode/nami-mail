export class IcsDateError extends Error {
  constructor(message = "The ICS date or time is invalid.") { super(message); this.name = "IcsDateError"; }
}

function utc(parts: number[]): number {
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts;
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(hour, minute, second, 0);
  if (year! < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new IcsDateError();
  return date.getTime();
}

function zonedTime(parts: number[], timeZone: string): number {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { throw new IcsDateError("The ICS time zone is not supported."); }
  const fields = (instant: number) => {
    const values = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    return ["year", "month", "day", "hour", "minute", "second"].map((name) => Number(values[name]));
  };
  const wall = utc(parts);
  const candidates = [-36, 0, 36].map((hours) => {
    const sample = wall + hours * 3600_000;
    return wall - (utc(fields(sample)) - sample);
  }).filter((candidate) => fields(candidate).every((value, index) => value === parts[index]));
  if (!candidates.length) throw new IcsDateError("The ICS time does not exist in its time zone.");
  // RFC 5545 uses the first occurrence when the clock repeats a wall time.
  return Math.min(...candidates);
}

export function parseCalendarDate(value: string, params: Record<string, string> = {}): { iso: string; allDay: boolean } {
  const input = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(input);
  if (date) return { iso: new Date(utc(date.slice(1).map(Number))).toISOString(), allDay: true };
  if (params.VALUE?.toUpperCase() === "DATE") throw new IcsDateError();
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(input);
  if (match) {
    const parts = match.slice(1, 7).map(Number);
    const wall = utc(parts);
    let instant = wall;
    if (!match[7]) {
      if (params.TZID) instant = zonedTime(parts, params.TZID);
      else {
        const local = new Date(0);
        local.setFullYear(parts[0]!, parts[1]! - 1, parts[2]!);
        local.setHours(parts[3]!, parts[4]!, parts[5]!, 0);
        if (local.getFullYear() !== parts[0] || local.getMonth() !== parts[1]! - 1 || local.getDate() !== parts[2]
          || local.getHours() !== parts[3] || local.getMinutes() !== parts[4] || local.getSeconds() !== parts[5]) throw new IcsDateError();
        instant = local.getTime();
      }
    }
    return { iso: new Date(instant).toISOString(), allDay: false };
  }
  // Retain explicit ISO-offset compatibility without accepting free-form or rolled dates.
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (iso) {
    utc(iso.slice(1, 7).map(Number));
    const instant = Date.parse(input);
    if (Number.isFinite(instant)) return { iso: new Date(instant).toISOString(), allDay: false };
  }
  throw new IcsDateError();
}
