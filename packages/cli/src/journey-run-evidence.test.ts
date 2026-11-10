import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunEvidenceSchema, type RunEvidence } from "@jevitate/adjudicator";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { BrowserSession } from "@jevitate/playwright";
import { EVIDENCE_FILE, JourneyRunEvidenceWriter, type JourneyRunEvidenceRequest } from "./journey-run-evidence.js";

/** #812/#800: one `journey run`'s RunEvidence v1, built from an in-memory run and written beside its result. */

const SECRET = "tok_S3CRET-marker-4417";
const PLAIN = "plainMARKER-9921";
const ORIGIN = "https://app.example.test";
const ENGINE = { version: "0.30.0-test", commit: "abc1234", builtAt: "2026-11-08T00:00:00.000Z" };

let dir: string;
let keyFile: string;

beforeEach(() => {
  installClock(new FakeClock());
  dir = mkdtempSync(join(tmpdir(), "jev-evidence-"));
  keyFile = join(dir, "home", "verify-checkpoint.key");
});

afterEach(() => {
  resetClock();
  rmSync(dir, { recursive: true, force: true });
});

/** A request as the browser reports it. */
class FakeRequest {
  constructor(
    readonly verb: string,
    readonly href: string,
  ) {}
  method(): string {
    return this.verb;
  }
  url(): string {
    return this.href;
  }
}

/** A session whose page has a context that emits Playwright's request events; or, with `watchable: false`, a test double's page with none. */
function session(watchable = true): { readonly session: BrowserSession; readonly context: EventEmitter } {
  const context = new EventEmitter();
  const page = watchable ? { context: () => context } : {};
  return { session: { page } as unknown as BrowserSession, context };
}

function writer(over: Partial<JourneyRunEvidenceRequest> = {}): JourneyRunEvidenceWriter {
  return new JourneyRunEvidenceWriter({
    channel: "cli",
    journey: { id: "checkout", hash: "a".repeat(64) },
    params: { email: PLAIN, password: SECRET },
    secretParamNames: ["password"],
    origin: ORIGIN,
    keyFile,
    engine: ENGINE,
    ...over,
  });
}

/** Runs three steps, each sending one write that is answered 200 (unless `answer` is false), and writes the evidence. */
function threeWriteRun(w: JourneyRunEvidenceWriter, context: EventEmitter, answer = true): string {
  for (const index of [1, 2, 3]) {
    w.beginStep(index);
    const request = new FakeRequest("POST", `${ORIGIN}/api/users/${encodeURIComponent(PLAIN)}/items?token=${SECRET}`);
    context.emit("request", request);
    context.emit("request", new FakeRequest("GET", `${ORIGIN}/page?q=${PLAIN}`));
    if (answer) context.emit("response", { request: () => request, status: () => 200 });
    w.noteStep({ index, kind: "click", outcome: "ok", postcondition: "held" });
  }
  const out = join(dir, "logs", "2026-11-08", "run-1");
  expect(w.finish(out)).toBeUndefined();
  return join(out, EVIDENCE_FILE);
}

function read(file: string): { readonly text: string; readonly record: RunEvidence } {
  const text = readFileSync(file, "utf8");
  return { text, record: RunEvidenceSchema.parse(JSON.parse(text)) };
}

describe("JourneyRunEvidenceWriter", () => {
  it("a run whose three writes were all answered has none open at close", () => {
    const w = writer();
    const { session: s, context } = session();
    w.attach(s);
    const { record } = read(threeWriteRun(w, context));
    expect(record.writes.openAtClose).toEqual({ known: true, value: 0 });
    expect(record.writes.sent).toEqual({ known: true, value: 3 });
    expect(record.writes.answered).toEqual({ known: true, value: 3 });
    expect(record.writes.aborted).toEqual({ known: true, value: 0 });
    expect(record.writes.shapes).toHaveLength(3);
    expect(record.writes.shapes.every((sh) => sh.method === "POST" && sh.count === 1 && sh.status.known && sh.status.value === "2xx")).toBe(true);
    expect(record.steps.map((st) => st.writes)).toEqual([1, 2, 3].map(() => ({ known: true, value: 1 })));
    expect(record.subject).toEqual({ kind: "journey-run", journey: { id: "checkout", hash: "a".repeat(64) } });
    expect(record.run).toMatchObject({ mode: "automation", channel: "cli", target: { origin: ORIGIN, trust: "unknown" }, secretParamNames: ["password"] });
  });

  it("an unanswered write is open at close", () => {
    const w = writer();
    const { session: s, context } = session();
    w.attach(s);
    const { record } = read(threeWriteRun(w, context, false));
    expect(record.writes.openAtClose).toEqual({ known: true, value: 3 });
    expect(record.writes.answered).toEqual({ known: true, value: 0 });
  });

  it("a run whose page was never watched cannot tell what was open", () => {
    const w = writer();
    const { session: s, context } = session(false);
    w.attach(s);
    const { record } = read(threeWriteRun(w, context));
    const unknown = { known: false, reason: "page-not-watched" };
    expect(record.writes.openAtClose).toEqual(unknown);
    expect(record.writes.sent).toEqual(unknown);
    expect(record.steps.every((st) => !st.writes.known && st.writes.reason === "page-not-watched")).toBe(true);
    expect(record.writes.shapes).toEqual([]);
  });

  it("the params digest binds the non-secret values and none of the secret ones", () => {
    const digestOf = (params: Record<string, string>): string => {
      const w = writer({ params });
      const out = join(dir, "out", Object.values(params).join("-"));
      expect(w.finish(out)).toBeUndefined();
      return read(join(out, EVIDENCE_FILE)).record.run.paramsDigest;
    };
    const a = digestOf({ email: PLAIN, password: SECRET });
    const b = digestOf({ password: "another-secret-value", email: PLAIN });
    const c = digestOf({ email: `${PLAIN}-changed`, password: SECRET });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("writes a file RunEvidenceSchema parses, with no secret or parameter value anywhere in it", () => {
    const w = writer();
    const { session: s, context } = session();
    w.attach(s);
    w.noteValue("xtr4ct3d-MARKER");
    context.emit("request", new FakeRequest("PUT", `https://${PLAIN.toLowerCase()}.other.test/v1/xtr4ct3d-MARKER`));
    w.note("the run ended at its last step");
    const file = threeWriteRun(w, context);
    const { text, record } = read(file);
    expect(() => RunEvidenceSchema.parse(JSON.parse(text))).not.toThrow();
    expect(record.notes).toEqual(["the run ended at its last step"]);
    for (const marker of [SECRET, PLAIN, PLAIN.toLowerCase(), encodeURIComponent(PLAIN), "xtr4ct3d-MARKER"]) expect(text).not.toContain(marker);
    expect(text.toLowerCase()).not.toContain("marker");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it("writes nothing when the key cannot be used", () => {
    const w = writer({ keyFile: dir });
    const out = join(dir, "never");
    expect(w.finish(out)).toMatch(/key .* cannot be used/);
    expect(() => statSync(join(out, EVIDENCE_FILE))).toThrow();
  });

  it("writes nothing when the record does not pass its schema", () => {
    const w = writer({ secretParamNames: ["not a token"] });
    const out = join(dir, "invalid");
    expect(w.finish(out)).toMatch(/did not pass its schema/);
    expect(() => statSync(join(out, EVIDENCE_FILE))).toThrow();
  });
});
