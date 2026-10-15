import { describe, expect, it } from "vitest";
import type { HttpCheck, RecordedStep } from "@jevitate/recording";
import { lintJourney, type Journey } from "./index.js";

// #543 — an `http` end-state check in the assertion-strength lint.

const meta = { id: "reset", name: "Reset", promoted: false, params: [], createdAtIso: "2026-10-15T00:00:00Z" };
const write: RecordedStep = {
  step: { kind: "click", target: { testId: "send" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Sent" } },
  delta: { verdict: "relevant-change", why: "sent", changes: ["status"], requests: ["POST /api/reset → 202"], overheadMs: 1 },
};
const outbox: HttpCheck = { kind: "http", method: "GET", url: "http://localhost:8025/api/messages", json: [{ path: "$.messages[*].Subject", op: "includes", value: "Reset" }] };
const fixtures = { file: ".jevitate/fixtures/reset.json", specHash: "abc" };

function j(metadata: Partial<Journey["metadata"]>): Journey {
  return { metadata: { ...meta, ...metadata }, recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/forgot", steps: [write] }] } };
}

const rules = (journey: Journey): string[] => lintJourney(journey).map((f) => f.rule);

describe("#543 lint: http end-state check", () => {
  it("satisfies no-persistence-check", () => {
    expect(rules(j({ endState: [outbox], allowedOrigins: ["http://localhost:8025"], fixtures }))).not.toContain("no-persistence-check");
  });

  it("covers the last write's effect (no write-without-effect)", () => {
    const journey = j({ endState: [outbox], allowedOrigins: ["http://localhost:8025"], fixtures });
    journey.recording.pages[0]!.steps[0] = { ...write, step: { kind: "click", target: { testId: "send" } } };
    expect(rules(journey)).not.toContain("write-without-effect");
  });

  it("flags http-check-off-allowlist when the origin is not the site or an allowed origin", () => {
    expect(rules(j({ endState: [outbox], fixtures }))).toContain("http-check-off-allowlist");
  });

  it("does not flag http-check-off-allowlist for a recorded allowed origin", () => {
    expect(rules(j({ endState: [outbox], allowedOrigins: ["http://localhost:8025"], fixtures }))).not.toContain("http-check-off-allowlist");
  });

  it("warns http-check-without-reset when the Journey records no fixtures", () => {
    expect(rules(j({ endState: [outbox], allowedOrigins: ["http://localhost:8025"] }))).toContain("http-check-without-reset");
  });

  it("does not warn http-check-without-reset when fixtures are recorded", () => {
    expect(rules(j({ endState: [outbox], allowedOrigins: ["http://localhost:8025"], fixtures }))).not.toContain("http-check-without-reset");
  });
});
