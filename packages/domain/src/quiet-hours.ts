import { DateTime } from "luxon";
import type { QuietHours } from "./interaction-policy.js";

interface HourMinute {
  hour: number;
  minute: number;
}

function parseHm(hm: string): HourMinute {
  const [hourStr, minuteStr] = hm.split(":");
  return { hour: Number(hourStr), minute: Number(minuteStr) };
}

function minutesOfDay({ hour, minute }: HourMinute): number {
  return hour * 60 + minute;
}

/**
 * Whether `nowMin` (minutes since local midnight) falls within [startMin, endMin).
 * When `startMin > endMin`, the window wraps past midnight (e.g. 20:00-08:00).
 */
function windowContainsMinute(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  return nowMin >= startMin || nowMin < endMin;
}

export function isWithinQuietHours(nowIso: string, qh: QuietHours): boolean {
  const now = DateTime.fromISO(nowIso, { zone: qh.timezone });
  const nowMin = minutesOfDay(now);

  return qh.windows.some((window) => {
    const startMin = minutesOfDay(parseHm(window.start));
    const endMin = minutesOfDay(parseHm(window.end));
    return windowContainsMinute(nowMin, startMin, endMin);
  });
}

export function nextOpenAfter(nowIso: string, qh: QuietHours): string {
  const now = DateTime.fromISO(nowIso, { zone: qh.timezone });
  const nowMin = minutesOfDay(now);

  for (const window of qh.windows) {
    const start = parseHm(window.start);
    const end = parseHm(window.end);
    const startMin = minutesOfDay(start);
    const endMin = minutesOfDay(end);

    if (!windowContainsMinute(nowMin, startMin, endMin)) {
      continue;
    }

    let closeAt = now.set({
      hour: end.hour,
      minute: end.minute,
      second: 0,
      millisecond: 0,
    });

    // Wrap-around window (e.g. 20:00-08:00): if we're in the pre-midnight
    // portion (nowMin >= startMin), the window's end falls on the next day.
    if (startMin > endMin && nowMin >= startMin) {
      closeAt = closeAt.plus({ days: 1 });
    }

    const closeIso = closeAt.toISO({ suppressMilliseconds: true });
    if (closeIso === null) {
      throw new Error(`nextOpenAfter: could not compute ISO timestamp for ${nowIso}`);
    }
    return closeIso;
  }

  return nowIso;
}
