import { describe, it, expect } from "vitest";
import {
  DotnetEntryGrouper,
  levelAtLeast,
  matchesLogDefect,
  normalizeLogMessage,
  parseLogDefectSpec,
  parseLogLine,
  serverLogFingerprint,
  LogSpecError,
} from "./log-lines.js";

describe("parseLogLine — JSON logs", () => {
  it("reads level/severity and time/timestamp fields", () => {
    const l = parseLogLine('{"level":"error","time":"2026-09-24T10:00:00.000Z","message":"boom"}', 1000, "file:app.log");
    expect(l.level).toBe("error");
    expect(l.message).toBe("boom");
    expect(l.ownTimestamp).toBe(true);
    expect(l.epochMs).toBe(Date.parse("2026-09-24T10:00:00.000Z"));
    expect(l.source).toBe("file:app.log");
  });

  it("accepts severity + @timestamp + msg", () => {
    const l = parseLogLine('{"severity":"WARN","@timestamp":"2026-09-24T10:00:01.000Z","msg":"careful"}', 1000, "x");
    expect(l.level).toBe("warn");
    expect(l.message).toBe("careful");
  });

  it("accepts a numeric unix-seconds timestamp", () => {
    const l = parseLogLine('{"level":"info","ts":1758700000,"message":"hi"}', 1000, "x");
    expect(l.ownTimestamp).toBe(true);
    expect(l.epochMs).toBe(1758700000 * 1000);
  });

  it("falls back to the whole line as the message when no message-ish field exists", () => {
    const raw = '{"level":"error","code":42}';
    const l = parseLogLine(raw, 1000, "x");
    expect(l.message).toBe(raw);
  });

  it("falls back to arrival time and unknown level for a JSON object with no level", () => {
    const l = parseLogLine('{"hello":"world"}', 5000, "x");
    expect(l.level).toBe("unknown");
    expect(l.epochMs).toBe(5000);
    expect(l.ownTimestamp).toBe(false);
  });
});

describe("parseLogLine — tracing-subscriber JSON (#169)", () => {
  // Redacted shape of Preveti's real lines: tracing-subscriber's JSON formatter nests the actual
  // message under `fields.message`, not at the top level — the old code fell back to the WHOLE raw
  // line, which `messageClass` then mangled into `{<s>:<s>,<s>:<s>,…}`.
  const WARN_LINE =
    '{"timestamp":"2026-09-24T21:03:11.442Z","level":"WARN","fields":{"message":"no resolvable active subscription tier for org 4471","error":"NotFound"},"target":"preveti_api::plan_service"}';
  const ERROR_LINE =
    '{"timestamp":"2026-09-24T21:04:02.918Z","level":"ERROR","fields":{"message":"plan lifecycle step failed — will retry next tick"},"target":"preveti_api::scheduler"}';

  it("extracts the message from fields.message instead of normalizing the whole object", () => {
    const l = parseLogLine(WARN_LINE, 1000, "x");
    expect(l.level).toBe("warn");
    expect(l.message).toBe("no resolvable active subscription tier for org 4471");
    expect(l.message).not.toContain("{");
  });

  it("reads the target field (tracing's own module path)", () => {
    const l = parseLogLine(WARN_LINE, 1000, "x");
    expect(l.target).toBe("preveti_api::plan_service");
  });

  it("two distinct fields.message lines from different targets normalize to distinct messages", () => {
    const a = parseLogLine(WARN_LINE, 1000, "x");
    const b = parseLogLine(ERROR_LINE, 1000, "x");
    expect(normalizeLogMessage(a.message)).not.toBe(normalizeLogMessage(b.message));
  });

  it("prefers top-level message/msg over fields.message when both are present", () => {
    const l = parseLogLine('{"level":"info","message":"top wins","fields":{"message":"nested loses"}}', 1000, "x");
    expect(l.message).toBe("top wins");
  });

  it("falls back to @message when neither message/msg nor fields.message exist", () => {
    const l = parseLogLine('{"level":"info","@message":"ecs-style message"}', 1000, "x");
    expect(l.message).toBe("ecs-style message");
  });

  it("still falls back to the whole line when no message-ish field exists anywhere", () => {
    const raw = '{"level":"info","fields":{"count":3}}';
    const l = parseLogLine(raw, 1000, "x");
    expect(l.message).toBe(raw);
  });
});

describe("parseLogLine — logfmt", () => {
  it("reads level= and msg= (quoted value)", () => {
    const l = parseLogLine('time=2026-09-24T10:00:00Z level=error msg="Not Authorized for feature X"', 1000, "x");
    expect(l.level).toBe("error");
    expect(l.message).toBe("Not Authorized for feature X");
    expect(l.ownTimestamp).toBe(true);
  });

  it("does not misparse an unrelated key=value pair as logfmt", () => {
    const l = parseLogLine("user clicked a=b in the console", 1000, "x");
    // Only one pair and no level/msg key: falls through to the bracketed/bare parser, unknown level.
    expect(l.level).toBe("unknown");
  });
});

describe("parseLogLine — bracketed/bare level fallback", () => {
  it("reads a bracketed level and a leading ISO timestamp", () => {
    const l = parseLogLine("2026-09-24T10:00:00.000Z [ERROR] request failed", 1000, "x");
    expect(l.level).toBe("error");
    expect(l.ownTimestamp).toBe(true);
  });

  it("reads a bare level word", () => {
    const l = parseLogLine("WARN: low disk space", 1000, "x");
    expect(l.level).toBe("warn");
  });

  it("falls back fully to arrival time and unknown level for plain text", () => {
    const l = parseLogLine("just some text", 1234, "x");
    expect(l.level).toBe("unknown");
    expect(l.epochMs).toBe(1234);
  });

  it("never throws on empty or malformed input", () => {
    expect(parseLogLine("", 1, "x").level).toBe("unknown");
    expect(parseLogLine("   ", 1, "x").level).toBe("unknown");
    expect(() => parseLogLine('{"level":', 1, "x")).not.toThrow();
  });
});

describe("parseLogLine — .NET default console format (#165)", () => {
  // Redacted shape of the real dogfooding sample (issue #165): a "fail:"/"warn:" header line
  // (`Category[EventId]`) followed by the message on an indented continuation line.
  const FAIL_ENTRY = "fail: OutboundLabs.Orchestrate.Administration.StripeReconciliationHostedService[0]\n      Stripe reconciliation sweep failed for hour 2026-09-24T21:00:00Z";
  const WARN_ENTRY =
    "warn: Microsoft.Extensions.Diagnostics.HealthChecks.DefaultHealthCheckService[103]\n      Health check stripe-integration with status Degraded";

  it("maps fail: to error and reads the message from the continuation line", () => {
    const l = parseLogLine(FAIL_ENTRY, 1000, "x");
    expect(l.level).toBe("error");
    expect(l.message).toBe("Stripe reconciliation sweep failed for hour 2026-09-24T21:00:00Z");
  });

  it("maps warn: to warn and carries the category as target", () => {
    const l = parseLogLine(WARN_ENTRY, 1000, "x");
    expect(l.level).toBe("warn");
    expect(l.message).toBe("Health check stripe-integration with status Degraded");
    expect(l.target).toBe("Microsoft.Extensions.Diagnostics.HealthChecks.DefaultHealthCheckService");
  });

  it("maps crit: to error and dbug:/trce: to debug", () => {
    expect(parseLogLine("crit: App.Service[1]\n      boom", 1000, "x").level).toBe("error");
    expect(parseLogLine("dbug: App.Service[1]\n      details", 1000, "x").level).toBe("debug");
    expect(parseLogLine("trce: App.Service[1]\n      details", 1000, "x").level).toBe("debug");
  });

  it("info: header noise (no meaningful body) never claims the whole multi-entry log as one message", () => {
    const l = parseLogLine("info: webapi.Middleware.CallContextMiddleware[0]\n      Handled request in 4ms", 1000, "x");
    expect(l.level).toBe("info");
    expect(l.message).toBe("Handled request in 4ms");
  });

  it("joins MULTIPLE continuation lines (e.g. an exception stack trace) into one entry", () => {
    const entry =
      "fail: App.Service[0]\n      Messages: request failed\n      Context: { Tier = Pro, Messages = [\"x\"] }\n      System.Exception: boom\n         at App.Service.Run() in /src/app.cs:line 42";
    const l = parseLogLine(entry, 1000, "x");
    expect(l.level).toBe("error");
    expect(l.message).toContain("Messages: request failed");
    expect(l.message).toContain("Context: { Tier = Pro");
    expect(l.message).toContain("System.Exception: boom");
  });

  it("a bare header line with no continuation falls back to the category as the message", () => {
    const l = parseLogLine("info: App.Service[0]", 1000, "x");
    expect(l.level).toBe("info");
    expect(l.message).toBe("App.Service");
  });

  it("does not misparse an ordinary bracketed/bare line as .NET", () => {
    const l = parseLogLine("2026-09-24T10:00:00.000Z [ERROR] request failed", 1000, "x");
    expect(l.level).toBe("error");
    expect(l.target).toBeUndefined();
  });
});

describe("DotnetEntryGrouper (#165)", () => {
  it("buffers a header, then flushes it as one entry once a non-continuation line arrives", () => {
    const g = new DotnetEntryGrouper();
    expect(g.feed("fail: App.Service[0]", 1000)).toEqual([]);
    expect(g.feed("      the message", 1001)).toEqual([]);
    const out = g.feed("info: Other.Thing[1]", 1002);
    expect(out).toHaveLength(1);
    expect(out[0]?.raw).toBe("fail: App.Service[0]\n      the message");
    expect(out[0]?.epochMs).toBe(1000);
  });

  it("groups multiple continuation lines under one header", () => {
    const g = new DotnetEntryGrouper();
    g.feed("fail: App.Service[0]", 1000);
    g.feed("      line one", 1001);
    g.feed("      line two", 1002);
    const flushed = g.flush();
    expect(flushed?.raw).toBe("fail: App.Service[0]\n      line one\n      line two");
  });

  it("an ordinary (non-.NET) line with no pending header passes straight through, unbuffered", () => {
    const g = new DotnetEntryGrouper();
    const out = g.feed('{"level":"info","message":"hi"}', 1000);
    expect(out).toEqual([{ raw: '{"level":"info","message":"hi"}', epochMs: 1000 }]);
  });

  it("flush() is a no-op when nothing is pending", () => {
    const g = new DotnetEntryGrouper();
    expect(g.flush()).toBeUndefined();
  });

  it("two back-to-back headers with no continuation each become their own one-line entry", () => {
    const g = new DotnetEntryGrouper();
    expect(g.feed("info: A[0]", 1000)).toEqual([]);
    const out = g.feed("info: B[0]", 1001);
    expect(out).toEqual([{ raw: "info: A[0]", epochMs: 1000 }]);
    const flushed = g.flush();
    expect(flushed).toEqual({ raw: "info: B[0]", epochMs: 1001 });
  });
});

describe("levelAtLeast", () => {
  it("orders error > warn > info > debug", () => {
    expect(levelAtLeast("error", "warn")).toBe(true);
    expect(levelAtLeast("warn", "error")).toBe(false);
    expect(levelAtLeast("error", "error")).toBe(true);
  });

  it("unknown is never >= a named level (fail closed)", () => {
    expect(levelAtLeast("unknown", "debug")).toBe(false);
  });

  it("any level is >= unknown", () => {
    expect(levelAtLeast("debug", "unknown")).toBe(true);
  });
});

describe("normalizeLogMessage", () => {
  it("strips an ISO timestamp, a uuid, quoted values and numbers into one stable class", () => {
    const a = normalizeLogMessage('2026-09-24T10:00:00Z request 3f6b6b1e-2d0c-4a6a-9f0a-9a2f6b6b1e2d failed after 3 retries "user-42"');
    const b = normalizeLogMessage('2026-09-24T11:15:22Z request 9a2f6b6b-1e2d-0c4a-6a9f-0a3f6b6b1e2d failed after 9 retries "user-7"');
    expect(a).toBe(b);
  });

  it("two occurrences that differ only by id/count/timestamp normalize identically", () => {
    const a = normalizeLogMessage("Not Authorized for feature AllOrganizations_View (user 123)");
    const b = normalizeLogMessage("Not Authorized for feature AllOrganizations_View (user 456)");
    expect(a).toBe(b);
  });
});

describe("serverLogFingerprint", () => {
  it("is stable across two occurrences that normalize identically", () => {
    const fp1 = serverLogFingerprint("/api/orgs/123", normalizeLogMessage("no resolvable active subscription tier for org 123"));
    const fp2 = serverLogFingerprint("/api/orgs/456", normalizeLogMessage("no resolvable active subscription tier for org 456"));
    expect(fp1).toBe(fp2); // same route TEMPLATE (:id) + same message class
  });

  it("differs across routes", () => {
    const msg = normalizeLogMessage("boom");
    expect(serverLogFingerprint("/api/a", msg)).not.toBe(serverLogFingerprint("/api/b", msg));
  });

  it("unattributed lines use a distinct, stable '(run)' bucket", () => {
    const msg = normalizeLogMessage("boom");
    const fp1 = serverLogFingerprint("(run)", msg);
    const fp2 = serverLogFingerprint("(run)", msg);
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(serverLogFingerprint("/api/a", msg));
  });

  it("is a 16-hex-char string", () => {
    expect(serverLogFingerprint("/x", "y")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("two messages that normalize identically but come from different targets are DISTINCT (#169)", () => {
    const msg = normalizeLogMessage("request failed");
    const fp1 = serverLogFingerprint("/x", msg, "preveti_api::plan_service");
    const fp2 = serverLogFingerprint("/x", msg, "preveti_api::scheduler");
    expect(fp1).not.toBe(fp2);
  });

  it("an undefined/empty target does not change the fingerprint vs. omitting it entirely", () => {
    const msg = normalizeLogMessage("boom");
    expect(serverLogFingerprint("/x", msg)).toBe(serverLogFingerprint("/x", msg, undefined));
    expect(serverLogFingerprint("/x", msg)).toBe(serverLogFingerprint("/x", msg, ""));
  });
});

describe("parseLogDefectSpec", () => {
  it("parses a level name", () => {
    const m = parseLogDefectSpec("error");
    expect(m).toEqual({ kind: "level", level: "error", raw: "error" });
  });

  it("parses a /regex/flags pattern", () => {
    const m = parseLogDefectSpec("/Not Authorized/i");
    expect(m.kind).toBe("pattern");
    if (m.kind === "pattern") {
      expect(m.re.test("Not Authorized for feature X")).toBe(true);
      expect(m.re.flags).toBe("i");
    }
  });

  it("rejects an unknown level name", () => {
    expect(() => parseLogDefectSpec("catastrophic")).toThrow(LogSpecError);
  });

  it("rejects an invalid regex", () => {
    expect(() => parseLogDefectSpec("/(unterminated/")).toThrow(LogSpecError);
  });

  it("rejects an overly long pattern (bounded regex)", () => {
    const long = `/${"a".repeat(600)}/`;
    expect(() => parseLogDefectSpec(long)).toThrow(LogSpecError);
  });

  it("never uses eval — a pattern is compiled via new RegExp only", () => {
    // A spec that LOOKS like code is just a pattern, never executed.
    const m = parseLogDefectSpec("/process.exit(1)/");
    expect(m.kind).toBe("pattern");
  });
});

describe("matchesLogDefect", () => {
  it("a level matcher matches level >= threshold", () => {
    const m = parseLogDefectSpec("warn");
    expect(matchesLogDefect({ level: "error", raw: "x" }, m)).toBe(true);
    expect(matchesLogDefect({ level: "warn", raw: "x" }, m)).toBe(true);
    expect(matchesLogDefect({ level: "info", raw: "x" }, m)).toBe(false);
  });

  it("a pattern matcher matches the RAW line regardless of level", () => {
    const m = parseLogDefectSpec("/Not Authorized for feature/");
    expect(matchesLogDefect({ level: "unknown", raw: "Not Authorized for feature AllOrganizations_View" }, m)).toBe(true);
    expect(matchesLogDefect({ level: "unknown", raw: "all good" }, m)).toBe(false);
  });
});
