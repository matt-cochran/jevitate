import type { Control } from "../index.js";

/**
 * Field-semantics input-value selection for the adversarial mission (spec §3.1:
 * "never blind fuzz"). A misuse step deliberately overrides Jev's free-form
 * fill with a boundary/empty/long/unicode/invalid value chosen by the field's
 * role/name — never a generative guess, never real PII, never a real recipient.
 */

export type InputStrategy = "empty" | "boundary" | "long" | "unicode" | "invalid" | "normal";

function isEmailLike(control: Control): boolean {
  return control.inputType === "email" || /e-?mail/i.test(control.name ?? "");
}
function isUrlLike(control: Control): boolean {
  return control.inputType === "url" || /\burl\b|website/i.test(control.name ?? "");
}
function isTelLike(control: Control): boolean {
  return control.inputType === "tel" || /\bphone\b|telephone/i.test(control.name ?? "");
}
function isDateLike(control: Control): boolean {
  return control.inputType === "date" || control.inputType === "datetime-local" || control.inputType === "month";
}
/** `input[type=number]` or an ARIA `spinbutton` (#121) — a numeric-only field, never typed with text. */
function isNumericInput(control: Control): boolean {
  return control.inputType === "number" || control.role === "spinbutton";
}
function isNumericLike(name: string): boolean {
  return /quantity|qty|amount|count|price|age/i.test(name);
}

function num(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Numeric boundary values (#121) for `input[type=number]`/`spinbutton`, respecting `min`/`max`/
 * `step` when the field declares them: one step below the minimum, one step above the maximum,
 * zero, a negative value, a very large value, and a decimal — never a text string, since Playwright
 * fails a number input's fill on anything that does not parse as a number ("Cannot type text into
 * input[type=number]"), and repeating that same mistake burns the run's budget without adapting.
 */
function numericValueFor(strategy: InputStrategy, control: Control): string {
  const min = num(control.min);
  const max = num(control.max);
  const step = num(control.step);
  const gran = step !== undefined && step > 0 ? step : 1;
  switch (strategy) {
    case "empty":
      return "";
    case "boundary":
      return String(min !== undefined ? min - gran : -1);
    case "long":
      return String(max !== undefined ? max + gran : 1_000_000_000);
    case "unicode":
      // A field-typed value stands in for "unicode": text is never accepted here, so a decimal
      // (never valid unless the field allows fractional steps) covers the same "surprising input"
      // intent without repeating the fill error a real unicode string would cause.
      return String((min ?? 0) + gran / 2);
    case "invalid": {
      const zeroInRange = (min === undefined || 0 >= min) && (max === undefined || 0 <= max);
      return zeroInRange ? "-1" : "0";
    }
    case "normal":
      if (min !== undefined && max !== undefined) return String(Math.floor((min + max) / 2));
      if (min !== undefined) return String(min);
      if (max !== undefined) return String(max);
      return "1";
  }
}

/** `type=email`/`url`/`tel` — a syntactically valid value for `normal`/`boundary`, an invalid one for `invalid`. */
function typedValueFor(strategy: InputStrategy, control: Control): string | undefined {
  if (isEmailLike(control)) {
    switch (strategy) {
      case "boundary":
        return `${"x".repeat(60)}@example.test`;
      case "invalid":
        return "not-an-email";
      case "normal":
        return "test@example.test";
    }
  }
  if (isUrlLike(control)) {
    switch (strategy) {
      case "boundary":
        return `https://example.test/${"x".repeat(500)}`;
      case "invalid":
        return "not a url";
      case "normal":
        return "https://example.test/";
    }
  }
  if (isTelLike(control)) {
    switch (strategy) {
      case "boundary":
        return "+1".padEnd(20, "9");
      case "invalid":
        return "not-a-phone-number";
      case "normal":
        return "+15555550100";
    }
  }
  return undefined;
}

/** A `YYYY-MM-DD` date `days` away from `iso`; `iso` itself when it does not parse. */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `type=date`/`datetime-local`/`month` (#121): EVERY strategy returns a syntactically valid ISO
 * date, respecting `min`/`max` when declared — a malformed date string fails a date input's fill
 * the same way a text string fails `input[type=number]` (never reaching the app), so "surprising
 * input" here means a boundary/out-of-range date, never invalid syntax.
 */
function dateValueFor(strategy: InputStrategy, control: Control): string {
  const min = control.min ?? undefined;
  const max = control.max ?? undefined;
  switch (strategy) {
    case "empty":
      return "";
    case "boundary":
      return min !== undefined ? shiftDate(min, -1) : "1900-01-01";
    case "long":
      return max !== undefined ? shiftDate(max, 1) : "9999-12-31";
    case "unicode":
      return "0001-01-01";
    case "invalid":
      return max !== undefined ? shiftDate(max, 1) : min !== undefined ? shiftDate(min, -1) : "9999-12-31";
    case "normal":
      return "2024-06-15";
  }
}

/** Field-semantics value selection — NEVER blind fuzz (spec §3.1). */
export function valueFor(strategy: InputStrategy, control: Control): string {
  if (strategy === "empty") return "";
  if (isNumericInput(control)) return numericValueFor(strategy, control);
  if (isDateLike(control)) return dateValueFor(strategy, control);
  const typed = typedValueFor(strategy, control);
  if (typed !== undefined) return typed;
  const name = control.name ?? "";
  switch (strategy) {
    case "boundary":
      return isNumericLike(name) ? "0" : "x";
    case "long":
      return "x".repeat(2000);
    case "unicode":
      return "مرحبا 😀 тест";
    case "invalid":
      return isNumericLike(name) ? "-1" : "\u0000invalid\u0000";
    case "normal":
      return "test-value";
  }
}
