import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { DoneReading } from "@jevitate/adjudicator";
import { evaluateJobDoneCheck, readDoneCheck, type BrowserPort, type DoneCheckSession } from "./journey-done-check.js";

const SECRET_VALUE = "hunter2-ZZ9";

interface Fake {
  port: BrowserPort;
  opened: string[];
  closed: string[];
  navigated: string[];
  checks: string[];
}

function fake(opts: { navigateThrows?: boolean; result?: boolean | "unevaluable" } = {}): Fake {
  const f: Fake = { opened: [], closed: [], navigated: [], checks: [], port: undefined as never };
  let n = 0;
  f.port = {
    async openContext() {
      const id = `fresh-${++n}`;
      f.opened.push(id);
      const s: DoneCheckSession = {
        id,
        async navigate(url) {
          f.navigated.push(url);
          if (opts.navigateThrows) throw new Error(`net::ERR ${url} ${SECRET_VALUE}`);
        },
        async evaluate(check) {
          f.checks.push(check);
          return opts.result ?? true;
        },
        async close() {
          f.closed.push(id);
        },
      };
      return s;
    },
  };
  return f;
}

const spec = { version: 1 as const, at: "/items/${name}", check: "textIncludes:#list|${name}" };
const base = (f: Fake) => ({ spec, origin: "http://app.test", auth: { storageState: "s.json", runContextId: "run-ctx" }, params: { name: SECRET_VALUE }, extracts: {}, browserPort: f.port });

const reading = (v: boolean | null): DoneReading => ({
  value: v === null ? { known: false, reason: "session-unavailable" } : { known: true, value: v },
  session: "fresh",
  at: "pre",
  durationMs: 1,
});

beforeEach(() => installClock(new FakeClock()));
afterEach(() => resetClock());

describe("readDoneCheck", () => {
  it("opens a context other than the run's and closes it", async () => {
    const f = fake();
    const r = await readDoneCheck(base(f));
    expect(r.value).toEqual({ known: true, value: true });
    expect(r.session).toBe("fresh");
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]).not.toBe("run-ctx");
    expect(f.closed).toEqual(f.opened);
    expect(f.navigated[0]).toContain("http://app.test/items/");
    expect(f.checks[0]).toContain(SECRET_VALUE);
  });

  it("a navigation that throws reads session-unavailable, closes, and verdicts unverified/reading-unknown", async () => {
    const f = fake({ navigateThrows: true });
    const r = await readDoneCheck(base(f));
    expect(r.value).toEqual({ known: false, reason: "session-unavailable" });
    expect(f.closed).toEqual(f.opened);
    expect(evaluateJobDoneCheck(r, reading(true))).toEqual({ attainment: "unverified", basis: "reading-unknown" });
    expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
  });

  it("an unbound placeholder or unevaluable check is unknown without leaking values", async () => {
    const f = fake({ result: "unevaluable" });
    const a = await readDoneCheck(base(f));
    const b = await readDoneCheck({ ...base(f), params: {} });
    expect(a.value).toEqual({ known: false, reason: "check-unevaluable" });
    expect(b.value).toEqual({ known: false, reason: "check-unevaluable" });
    expect(JSON.stringify([a, b])).not.toContain(SECRET_VALUE);
  });
});

describe("evaluateJobDoneCheck (§3.1)", () => {
  it.each([
    [reading(false), reading(true), { attainment: "achieved", basis: "done-check" }],
    [reading(false), reading(false), { attainment: "not-achieved", basis: "done-check" }],
    [reading(true), reading(true), { attainment: "unverified", basis: "already-true" }],
    [reading(null), reading(true), { attainment: "unverified", basis: "reading-unknown" }],
    [reading(false), reading(null), { attainment: "unverified", basis: "reading-unknown" }],
    [undefined, undefined, { attainment: "unverified", basis: "no-check" }],
  ] as const)("row %#", (before, after, want) => {
    expect(evaluateJobDoneCheck(before, after)).toEqual(want);
  });
});
