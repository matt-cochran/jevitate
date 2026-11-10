import { describe, expect, it } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import {
  doneCheckScope,
  isDoneCheckIssues,
  JobSchema,
  lintDoneCheck,
  parseDoneCheck,
  resolveDoneCheck,
  type DoneCheckIssue,
  type DoneCheckSpec,
  type Journey,
} from "./index.js";

// #800 (0.30.0 §3): the job done check contract.

const valid = { version: 1, at: "/invoices", check: "textIncludes:testId=row|${invoiceNo}" } as const;
const codes = (r: DoneCheckSpec | DoneCheckIssue[]): string[] => (isDoneCheckIssues(r) ? r.map((i) => i.code) : []);

const meta = { id: "pay", name: "Pay", promoted: true, params: ["invoiceNo"], createdAtIso: "2026-11-01T00:00:00Z", job: "pay-invoice" };
const writeStep: RecordedStep = {
  step: { kind: "click", target: { testId: "save" } },
  delta: { verdict: "relevant-change", why: "saved", changes: ["row"], requests: ["POST /api/invoices → 201"], overheadMs: 1 },
};
const readStep: RecordedStep = { step: { kind: "click", target: { testId: "open" } } };
function journey(steps: RecordedStep[], metadata: Partial<Journey["metadata"]> = {}): Journey {
  return { metadata: { ...meta, ...metadata }, recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/invoices", steps }] } };
}
const job = (done?: unknown) => ({ id: "pay-invoice", ...(done === undefined ? {} : { done }) });

describe("parseDoneCheck", () => {
  it("parses the design's example", () => {
    expect(parseDoneCheck(valid)).toEqual(valid);
  });

  it.each(["textIncludes:testId=row|x", "count:testId=row|min=1", "count:css=.row|min=1,max=3", "attr:testId=row|data-state=paid", "attr:testId=row|!hidden", "valueEquals:label=Total|${amount}", "http:GET /api/invoices/${invoiceNo}|status=2xx|jsonPath=$.state|equals=paid"])(
    "accepts the state kind %s",
    (check) => {
      expect(isDoneCheckIssues(parseDoneCheck({ ...valid, check }))).toBe(false);
    },
  );

  it.each(["visible:testId=row", "urlIncludes:/done", "requestMade:POST /api/invoices", "style:#x|color=red", "garbage"])("refuses the kind of %s", (check) => {
    expect(codes(parseDoneCheck({ ...valid, check }))).toContain("E_DONE_CHECK_KIND");
  });

  it("refuses a secret placeholder", () => {
    expect(codes(parseDoneCheck({ ...valid, check: "textIncludes:testId=row|${password}" }))).toContain("E_DONE_CHECK_SECRET_REF");
    expect(codes(parseDoneCheck({ ...valid, at: "/invoices?k=${secret}" }))).toContain("E_DONE_CHECK_SECRET_REF");
    expect(codes(parseDoneCheck({ ...valid, check: "http:GET /api/${setup.apiToken}" }))).toContain("E_DONE_CHECK_SECRET_REF");
    expect(codes(parseDoneCheck({ ...valid, distinguishedBy: ["sessionId"] }))).toContain("E_DONE_CHECK_SECRET_REF");
  });

  it("refuses a name the scope declares secret", () => {
    const r = parseDoneCheck({ ...valid, check: "textIncludes:testId=row|${customer}" }, { bound: ["customer"], secret: ["customer"] });
    expect(codes(r)).toContain("E_DONE_CHECK_SECRET_REF");
  });

  it("refuses step, anchor and reloadThen references", () => {
    expect(codes(parseDoneCheck({ ...valid, check: "textIncludes:testId=row|step:3" }))).toContain("E_DONE_CHECK_PATH_BOUND");
    expect(codes(parseDoneCheck({ ...valid, at: "/invoices/step:3" }))).toContain("E_DONE_CHECK_PATH_BOUND");
    expect(codes(parseDoneCheck({ ...valid, check: "textIncludes:anchor=saved|x" }))).toContain("E_DONE_CHECK_PATH_BOUND");
    expect(codes(parseDoneCheck({ ...valid, check: "textIncludes:testId=row|${anchor.saved}" }))).toContain("E_DONE_CHECK_PATH_BOUND");
    expect(codes(parseDoneCheck({ ...valid, check: "reloadThen:textIncludes:testId=row|x" }))).toContain("E_DONE_CHECK_PATH_BOUND");
    expect(codes(parseDoneCheck({ ...valid, check: "textIncludes:end-state:0|x" }))).toContain("E_DONE_CHECK_PATH_BOUND");
  });

  it("does not read step-like words as step references", () => {
    expect(isDoneCheckIssues(parseDoneCheck({ ...valid, check: "textIncludes:testId=footstep|done" }))).toBe(false);
  });

  it.each(["invoices", "https://evil.example/invoices", "//evil.example/x", "/a b", "/a\\b"])("refuses at %s as not a path on the origin", (at) => {
    expect(codes(parseDoneCheck({ ...valid, at }))).toContain("E_DONE_CHECK_AT");
  });

  it("refuses an http check off the origin or not a GET", () => {
    expect(codes(parseDoneCheck({ ...valid, check: "http:GET http://localhost:8025/api|status=2xx" }))).toContain("E_DONE_CHECK_SYNTAX");
    expect(codes(parseDoneCheck({ ...valid, check: "http:POST /api/invoices" }))).toContain("E_DONE_CHECK_SYNTAX");
  });

  it("refuses a malformed shape or check body", () => {
    expect(codes(parseDoneCheck({ ...valid, version: 2 }))).toContain("E_DONE_CHECK_SHAPE");
    expect(codes(parseDoneCheck({ ...valid, extra: 1 }))).toContain("E_DONE_CHECK_SHAPE");
    expect(codes(parseDoneCheck({ ...valid, session: "in-run" }))).toContain("E_DONE_CHECK_SHAPE");
    expect(codes(parseDoneCheck({ ...valid, check: "textIncludes:testId=row" }))).toContain("E_DONE_CHECK_SYNTAX");
    expect(codes(parseDoneCheck({ ...valid, check: "count:testId=row|min=x" }))).toContain("E_DONE_CHECK_SYNTAX");
    expect(codes(parseDoneCheck({ ...valid, check: "textIncludes:testId=row|${invoiceNo" }))).toContain("E_DONE_CHECK_SYNTAX");
  });

  it("checks placeholders against a scope when one is given", () => {
    expect(codes(parseDoneCheck(valid, { bound: ["other"] }))).toEqual(["E_DONE_CHECK_REF_UNBOUND"]);
    expect(isDoneCheckIssues(parseDoneCheck(valid, { bound: ["invoiceNo"] }))).toBe(false);
    expect(isDoneCheckIssues(parseDoneCheck({ ...valid, check: "textIncludes:testId=row|${setup.invoiceNo}" }, { bound: [] }))).toBe(false);
  });

  it("refuses a distinguishedBy name that is not one of the spec's placeholders", () => {
    expect(isDoneCheckIssues(parseDoneCheck({ ...valid, distinguishedBy: ["invoiceNo"] }))).toBe(false);
    expect(codes(parseDoneCheck({ ...valid, distinguishedBy: ["other"] }))).toContain("E_DONE_CHECK_SYNTAX");
  });
});

describe("doneCheckScope", () => {
  it("binds non-secret params and extract outputs, never a secret", () => {
    const j = journey([{ step: { kind: "extract", target: { testId: "no" }, as: "createdNo" } } as RecordedStep], {
      params: ["invoiceNo", "password"],
      parameters: [{ name: "customer", secret: true }],
    });
    const scope = doneCheckScope(j);
    expect(scope.bound).toEqual(["createdNo", "invoiceNo"]);
    expect(scope.secret).toEqual(expect.arrayContaining(["customer", "password"]));
  });
});

describe("resolveDoneCheck", () => {
  it("percent-encodes URL values and inserts text values as is", () => {
    const spec = { version: 1, at: "/invoices/${invoiceNo}", check: "http:GET /api/${invoiceNo}|jsonPath=$.no|equals=${invoiceNo}" } as const;
    expect(resolveDoneCheck(spec, { invoiceNo: "A/1 b" })).toEqual({ at: "/invoices/A%2F1%20b", check: "http:GET /api/A%2F1%20b|jsonPath=$.no|equals=A/1 b" });
  });

  it("refuses a missing value by name", () => {
    expect(codes(resolveDoneCheck(valid, {}))).toEqual(["E_DONE_CHECK_REF_UNBOUND"]);
  });
});

describe("no issue message carries a parameter value", () => {
  it("names only fields and placeholders", () => {
    const marker = "MARKER-7f3a-value";
    const messages: string[] = [];
    const collect = (r: unknown): void => {
      if (Array.isArray(r)) for (const i of r as DoneCheckIssue[]) messages.push(JSON.stringify(i));
    };
    collect(resolveDoneCheck({ ...valid, check: "textIncludes:testId=row|${password}" }, { invoiceNo: marker, password: marker }));
    collect(resolveDoneCheck({ ...valid, at: "/x/${missing}" }, { invoiceNo: marker }));
    collect(resolveDoneCheck({ ...valid, at: "/x/${step.1}" }, { "step.1": marker, invoiceNo: marker }));
    for (const spec of [{ ...valid, check: "textIncludes:testId=row|${apiKey}" }, { ...valid, at: "nope" }, { ...valid, check: "visible:x" }, { ...valid, version: 9 }]) {
      collect(parseDoneCheck(spec, { bound: ["invoiceNo"] }));
    }
    const findings = lintDoneCheck(job({ ...valid, check: "textIncludes:testId=row|${token}" }), [journey([writeStep])]);
    messages.push(JSON.stringify(findings));
    expect(messages.length).toBeGreaterThan(5);
    for (const m of messages) expect(m).not.toContain(marker);
  });
});

describe("lintDoneCheck", () => {
  it("flags a write Journey whose check lacks distinguishedBy", () => {
    const findings = lintDoneCheck(job(valid), [journey([writeStep])]);
    expect(findings).toEqual([expect.objectContaining({ rule: "done-check-cannot-be-false", level: "warning", job: "pay-invoice", journey: "pay" })]);
  });

  it("is clean with distinguishedBy naming the created value", () => {
    expect(lintDoneCheck(job({ ...valid, distinguishedBy: ["invoiceNo"] }), [journey([writeStep])])).toEqual([]);
  });

  it("does not flag a Journey that writes nothing", () => {
    expect(lintDoneCheck(job(valid), [journey([readStep])])).toEqual([]);
  });

  it("warns missing-done-check on a promoted linked Journey only", () => {
    const findings = lintDoneCheck(job(), [journey([readStep]), journey([readStep], { id: "draft", promoted: false }), journey([readStep], { id: "other", job: "other" })]);
    expect(findings).toEqual([expect.objectContaining({ rule: "missing-done-check", journey: "pay" })]);
  });

  it("reports parse issues as done-check-invalid, with the code", () => {
    const findings = lintDoneCheck(job({ ...valid, check: "textIncludes:testId=row|step:3" }), [journey([readStep])]);
    expect(findings).toEqual([expect.objectContaining({ rule: "done-check-invalid", level: "error", code: "E_DONE_CHECK_PATH_BOUND" })]);
  });

  it("reports a placeholder the linked Journey does not bind", () => {
    const findings = lintDoneCheck(job(valid), [journey([readStep], { params: [] })]);
    expect(findings).toEqual([expect.objectContaining({ rule: "done-check-invalid", code: "E_DONE_CHECK_REF_UNBOUND", journey: "pay" })]);
  });
});

describe("jobs.json done field", () => {
  const story = { id: "pay-invoice", trigger: "an invoice is due", motivation: "pay it", outcome: "stay in good standing" };
  it("is optional and shape-checked", () => {
    expect(JobSchema.safeParse(story).success).toBe(true);
    expect(JobSchema.safeParse({ ...story, done: valid }).success).toBe(true);
    expect(JobSchema.safeParse({ ...story, done: { ...valid, extra: true } }).success).toBe(false);
  });
});
