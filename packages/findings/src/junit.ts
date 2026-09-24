/**
 * JUnit XML for the CI gate (#137): one `<testsuite>` per suite target, one `<testcase>` per
 * suite item (a Journey, a goal, a mission, a verify-fix). A hard failure is a `<failure>`; a run
 * that could not prove anything (crashed, inconclusive, over budget) is an `<error>` — never a
 * pass; an item not run because `--changed-routes` excluded it is `<skipped>`.
 */

export type CaseStatus = "passed" | "failed" | "error" | "skipped";

export interface GateCase {
  /** The `<testsuite>` it belongs to (the suite target's name). */
  readonly suite: string;
  readonly classname: string;
  readonly name: string;
  readonly timeSec: number;
  readonly status: CaseStatus;
  /** One line for `message=` (failure/error/skipped). */
  readonly message?: string;
  /** The failure type (e.g. `invariant`, `journey-assertion`, `budget-exceeded`). */
  readonly type?: string;
  /** Body text (every failing finding, its key and reproduction). */
  readonly detail?: string;
  /** Path of the result the case was read from. */
  readonly resultPath?: string;
}

/** XML 1.0 text/attribute escape; strips characters XML 1.0 cannot carry at all. */
export function xmlEscape(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function counts(cases: readonly GateCase[]): { tests: number; failures: number; errors: number; skipped: number; time: number } {
  return {
    tests: cases.length,
    failures: cases.filter((c) => c.status === "failed").length,
    errors: cases.filter((c) => c.status === "error").length,
    skipped: cases.filter((c) => c.status === "skipped").length,
    time: cases.reduce((t, c) => t + c.timeSec, 0),
  };
}

function attrs(a: Record<string, string | number>): string {
  return Object.entries(a)
    .map(([k, v]) => `${k}="${xmlEscape(typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v)}"`)
    .join(" ");
}

function testcase(c: GateCase): string {
  const open = `    <testcase ${attrs({ classname: c.classname, name: c.name, time: c.timeSec })}`;
  const props =
    c.resultPath === undefined ? "" : `      <properties>\n        <property ${attrs({ name: "result", value: c.resultPath })}/>\n      </properties>\n`;
  const body = c.detail === undefined ? "" : xmlEscape(c.detail);
  const tag = c.status === "failed" ? "failure" : c.status === "error" ? "error" : c.status === "skipped" ? "skipped" : undefined;
  if (tag === undefined) return props === "" ? `${open}/>` : `${open}>\n${props}    </testcase>`;
  const detailAttrs = attrs({ message: c.message ?? c.status, ...(c.type === undefined ? {} : { type: c.type }) });
  const inner = body === "" ? `      <${tag} ${detailAttrs}/>` : `      <${tag} ${detailAttrs}>${body}</${tag}>`;
  return `${open}>\n${props}${inner}\n    </testcase>`;
}

export function renderJUnit(name: string, cases: readonly GateCase[], timestamp?: string): string {
  const suites = [...new Set(cases.map((c) => c.suite))];
  const total = counts(cases);
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites ${attrs({ name, tests: total.tests, failures: total.failures, errors: total.errors, skipped: total.skipped, time: total.time })}>`,
  ];
  for (const s of suites) {
    const own = cases.filter((c) => c.suite === s);
    const n = counts(own);
    lines.push(
      `  <testsuite ${attrs({
        name: s,
        tests: n.tests,
        failures: n.failures,
        errors: n.errors,
        skipped: n.skipped,
        time: n.time,
        ...(timestamp === undefined ? {} : { timestamp }),
      })}>`,
      ...own.map(testcase),
      `  </testsuite>`,
    );
  }
  lines.push(`</testsuites>`, "");
  return lines.join("\n");
}
