import { describe, it, expect } from "vitest";
import {
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
