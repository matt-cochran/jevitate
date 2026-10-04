import { describe, expect, it } from "vitest";
import { inWireFormat, normalizeTemporalValue, isTemporalInputType } from "./temporal-value.js";
import { checkFieldValue } from "./fill.js";

describe("date/time input values in their wire format (#332)", () => {
  it("normalizes human time spellings to HH:MM", () => {
    const cases: [string, string | null][] = [
      ["8:00 AM", "08:00"],
      ["8 AM", "08:00"],
      ["8am", "08:00"],
      ["8:30 p.m.", "20:30"],
      ["12:00 AM", "00:00"],
      ["12 pm", "12:00"],
      ["17:30", "17:30"],
      ["08:00", "08:00"],
      ["0800", "08:00"],
      ["8.15", "08:15"],
      ["8:00:30 pm", "20:00:30"],
      ["noon", "12:00"],
      ["8", null],
      ["13 pm", null],
      ["25:00", null],
      ["in the morning", null],
    ];
    for (const [v, want] of cases) expect(normalizeTemporalValue("time", v), v).toBe(want);
  });

  it("normalizes dates, months, weeks and datetime-local", () => {
    expect(normalizeTemporalValue("date", "2026-10-03")).toBe("2026-10-03");
    expect(normalizeTemporalValue("date", "10/3/2026")).toBe("2026-10-03");
    expect(normalizeTemporalValue("date", "31/12/2026")).toBe("2026-12-31");
    expect(normalizeTemporalValue("date", "October 3, 2026")).toBe("2026-10-03");
    expect(normalizeTemporalValue("date", "Sat, 3 Oct 2026")).toBe("2026-10-03");
    expect(normalizeTemporalValue("date", "2026-02-30")).toBeNull();
    expect(normalizeTemporalValue("date", "next Tuesday")).toBeNull();
    expect(normalizeTemporalValue("month", "October 2026")).toBe("2026-10");
    expect(normalizeTemporalValue("month", "10/2026")).toBe("2026-10");
    expect(normalizeTemporalValue("month", "2026-13")).toBeNull();
    expect(normalizeTemporalValue("week", "2026-W40")).toBe("2026-W40");
    expect(normalizeTemporalValue("week", "week 7, 2026")).toBe("2026-W07");
    expect(normalizeTemporalValue("week", "2026-W54")).toBeNull();
    expect(normalizeTemporalValue("datetime-local", "2026-10-03T08:00")).toBe("2026-10-03T08:00");
    expect(normalizeTemporalValue("datetime-local", "2026-10-03 8:00 AM")).toBe("2026-10-03T08:00");
    expect(normalizeTemporalValue("datetime-local", "October 3, 2026 at 5:30 pm")).toBe("2026-10-03T17:30");
    expect(normalizeTemporalValue("datetime-local", "October 3, 2026")).toBeNull();
    expect(normalizeTemporalValue("text", "8:00 AM")).toBe("8:00 AM");
    expect(isTemporalInputType("time")).toBe(true);
    expect(isTemporalInputType("text")).toBe(false);
    expect(isTemporalInputType(null)).toBe(false);
  });

  it("a fill value for a date/time input is checked and typed in its wire format", () => {
    const time = { tag: "input", inputType: "time" } as const;
    expect(checkFieldValue("8:00 AM", time, "Sat opens")).toBeNull();
    expect(checkFieldValue("in the morning", time, "Sat opens")).toMatch(/not a time value — this field takes HH:MM/);
    expect(inWireFormat(time, "8:00 AM")).toBe("08:00");
    expect(inWireFormat({ tag: "input", inputType: "text" }, "8:00 AM")).toBe("8:00 AM");
    expect(inWireFormat({ tag: "textarea", inputType: null }, "8:00 AM")).toBe("8:00 AM");
  });
});
