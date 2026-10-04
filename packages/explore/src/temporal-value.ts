/**
 * #332: a date/time `<input>` (`time`, `date`, `datetime-local`, `month`, `week`) only accepts its
 * HTML wire format — Playwright's `fill` throws "Malformed value" on `8:00 AM`. A value the goal or
 * the model writes the way people do (`8:00 AM`, `10/3/2026`, `October 2026`) is normalized here to
 * that format before it is typed; one that can't be read is rejected with the format it needs, so
 * the model sees what to type instead of failing the same fill five times.
 *
 * Pure string parsing: no Date objects (a value is never shifted by a time zone).
 */

/** The wire format each date/time input type takes, as shown to the model. */
export const TEMPORAL_FORMATS: Readonly<Record<string, string>> = {
  time: "HH:MM (24-hour, e.g. 08:00 or 17:30)",
  date: "YYYY-MM-DD (e.g. 2026-10-03)",
  "datetime-local": "YYYY-MM-DDTHH:MM (e.g. 2026-10-03T08:00)",
  month: "YYYY-MM (e.g. 2026-10)",
  week: "YYYY-Www (e.g. 2026-W40)",
};

/** True for an `<input type>` whose value must be in a date/time wire format. */
export function isTemporalInputType(inputType: string | null | undefined): boolean {
  return inputType !== null && inputType !== undefined && Object.hasOwn(TEMPORAL_FORMATS, inputType.toLowerCase());
}

const MONTHS = "january february march april may june july august september october november december".split(" ");

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A month name or its abbreviation ("oct", "Sept.", "October") → 1..12; null otherwise. */
function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(w));
  return i === -1 ? null : i + 1;
}

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** `8:00 AM`, `8am`, `8 p.m.`, `17:30`, `0800`, `noon`, `8:00:30 pm` → `HH:MM[:SS]`; null when unreadable. */
export function normalizeTime(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (v === "noon" || v === "midday") return "12:00";
  if (v === "midnight") return "00:00";
  const m = /^(\d{1,2})(?:[:.h](\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(a\.?m\.?|p\.?m\.?)?$/.exec(v) ?? /^(\d{2})(\d{2})()\s*(a\.?m\.?|p\.?m\.?)?$/.exec(v);
  if (m === null) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined || m[2] === "" ? 0 : Number(m[2]);
  const sec = m[3] === undefined || m[3] === "" ? null : Number(m[3]);
  const half = m[4]?.[0];
  // A bare hour needs am/pm ("8" alone could be a count); "08:00" / "0800" read as 24-hour.
  if (half === undefined && (m[2] === undefined || m[2] === "") && !/^\d{4}$/.test(v)) return null;
  if (half !== undefined) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half === "p" ? 12 : 0);
  }
  if (h > 23 || min > 59 || (sec !== null && sec > 59)) return null;
  return `${pad(h)}:${pad(min)}${sec === null || sec === 0 ? "" : `:${pad(sec)}`}`;
}

/** `2026-10-03`, `10/3/2026` (month first unless the first part is > 12), `3 Oct 2026`, `October 3, 2026` → `YYYY-MM-DD`. */
export function normalizeDate(value: string): string | null {
  const v = value.trim().replace(/\s+/g, " ");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (m !== null) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 12 ? isoDate(Number(m[3]), b, a) : isoDate(Number(m[3]), a, b);
  }
  m = /^(?:[a-z]+,? )?(\d{1,2})(?:st|nd|rd|th)? ([a-z]+\.?),? (\d{4})$/i.exec(v);
  if (m !== null) {
    const mo = monthOf(m[2]!);
    return mo === null ? null : isoDate(Number(m[3]), mo, Number(m[1]));
  }
  m = /^(?:[a-z]+,? )?([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(v);
  if (m !== null) {
    const mo = monthOf(m[1]!);
    return mo === null ? null : isoDate(Number(m[3]), mo, Number(m[2]));
  }
  return null;
}

/** `2026-10`, `10/2026`, `October 2026`, `Oct 2026` → `YYYY-MM`. */
export function normalizeMonth(value: string): string | null {
  const v = value.trim().replace(/\s+/g, " ");
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(v);
  if (m !== null) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${pad(Number(m[2]))}` : null;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(v);
  if (m !== null) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${pad(Number(m[1]))}` : null;
  m = /^([a-z]+\.?),? (\d{4})$/i.exec(v);
  if (m !== null) {
    const mo = monthOf(m[1]!);
    return mo === null ? null : `${m[2]}-${pad(mo)}`;
  }
  return null;
}

/** `2026-W40`, `2026-w40`, `2026 W40`, `week 40 2026` → `YYYY-Www`. */
export function normalizeWeek(value: string): string | null {
  const v = value.trim().replace(/\s+/g, " ");
  const isoLike = /^(\d{4})[- ]?w(\d{1,2})$/i.exec(v);
  const spoken = /^week (\d{1,2}),? (\d{4})$/i.exec(v);
  const [year, week] = isoLike !== null ? [isoLike[1], isoLike[2]] : spoken !== null ? [spoken[2], spoken[1]] : [undefined, undefined];
  if (year === undefined || week === undefined) return null;
  const w = Number(week);
  return w >= 1 && w <= 53 ? `${year}-W${pad(w)}` : null;
}

/** `2026-10-03T08:00`, `2026-10-03 8:00 AM`, `10/3/2026, 8am`, `October 3, 2026 at 5:30 pm` → `YYYY-MM-DDTHH:MM`. */
export function normalizeDateTime(value: string): string | null {
  const v = value.trim().replace(/\s+/g, " ");
  const iso = /^(\d{4}-\d{1,2}-\d{1,2})[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:z|[+-]\d{2}:?\d{2})?$/i.exec(v);
  if (iso !== null) {
    const d = normalizeDate(iso[1]!);
    const t = normalizeTime(iso[2]!);
    return d === null || t === null ? null : `${d}T${t}`;
  }
  // Split at the time part: the trailing `h[:mm[:ss]] [am|pm]` (optionally after "at" or a comma).
  const m = /^(.*?)(?:,| at)? (\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:a\.?m\.?|p\.?m\.?)?)$/i.exec(v);
  if (m === null) return null;
  const d = normalizeDate(m[1]!);
  const t = normalizeTime(m[2]!);
  return d === null || t === null ? null : `${d}T${t}`;
}

/**
 * The value in the wire format `inputType` takes, or null when it can't be read as one. A value
 * that already is in that format comes back unchanged.
 */
export function normalizeTemporalValue(inputType: string, value: string): string | null {
  switch (inputType.toLowerCase()) {
    case "time":
      return normalizeTime(value);
    case "date":
      return normalizeDate(value);
    case "datetime-local":
      return normalizeDateTime(value);
    case "month":
      return normalizeMonth(value);
    case "week":
      return normalizeWeek(value);
    default:
      return value;
  }
}
