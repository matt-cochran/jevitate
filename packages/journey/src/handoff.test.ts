import { describe, it, expect } from "vitest";
import {
  JourneySchema,
  validateFieldValue,
  readRecords,
  validateRecords,
  checkCompatibility,
  validateRequests,
  bindParams,
  recordFingerprint,
} from "./index.js";

// #582: the optional `metadata.outputs` / `metadata.inputs` blocks and the pure §4 validator.

const flatRecording = (names: string[]) => ({
  version: "1",
  site: "example",
  pages: [
    {
      url: "/",
      steps: names.map((as) => ({
        step: { kind: "extract", target: { css: `#${as}` }, as, expect: { kind: "urlIncludes", text: "/" } },
      })),
    },
  ],
});

const journey = (extra: Record<string, unknown>, names: string[] = []) => ({
  metadata: { id: "j", name: "j", promoted: false, params: [], createdAtIso: "2026-01-01T00:00:00Z", ...extra },
  recording: flatRecording(names),
});

const OUTPUTS = {
  contract: "community-conversation@1",
  key: ["commentId", "account"],
  fields: {
    commentId: { type: "id" },
    account: { type: "id" },
    sourceText: { type: "text" },
  },
};

const REQUEST = {
  fields: { commentId: { type: "id" }, account: { type: "id" }, replyText: { type: "text" } },
  key: ["commentId", "account"],
};

const INPUTS = {
  accepts: "community-conversation@1",
  request: REQUEST,
  bindings: {
    commentId: { record: "commentId" },
    replyIdentity: { record: "account" },
    expected_sourcetext: { record: "sourceText" },
    replyText: { request: "replyText" },
  },
};

const hIssue = (j: unknown): string[] => {
  const r = JourneySchema.safeParse(j);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

const hPaths = (j: unknown): (string | number)[][] => {
  const r = JourneySchema.safeParse(j);
  return r.success ? [] : r.error.issues.map((i) => [...i.path]);
};

const err = (type: Parameters<typeof validateFieldValue>[0], value: unknown, ctx?: { allowedOrigins?: string[] }) =>
  validateFieldValue(type, value, ctx);

describe("JourneySchema handoff blocks (#582)", () => {
  it("accepts a producing Journey's metadata.outputs", () => {
    const r = JourneySchema.safeParse(journey({ outputs: OUTPUTS }, ["commentId", "account", "sourceText"]));
    expect(r.success).toBe(true);
  });

  it("accepts a consuming Journey's metadata.inputs", () => {
    const params = ["commentId", "replyIdentity", "expected_sourcetext", "replyText"];
    const r = JourneySchema.safeParse(journey({ params, inputs: INPUTS }));
    expect(r.success).toBe(true);
  });

  it("accepts a Journey with neither outputs nor inputs (0.17.0 unchanged)", () => {
    const r = JourneySchema.safeParse(journey({}));
    expect(r.success).toBe(true);
  });

  it("refuses an unknown key inside metadata.outputs", () => {
    const bad = { ...OUTPUTS, bogus: 1 };
    expect(JourneySchema.safeParse(journey({ outputs: bad }, ["commentId", "account", "sourceText"])).success).toBe(false);
  });

  it("refuses an outputs contract that is not <name>@<major>", () => {
    expect(hIssue(journey({ outputs: { ...OUTPUTS, contract: "Community@1" } }, ["commentId", "account", "sourceText"]))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses an outputs field type outside id|text|path|url|timestamp", () => {
    const bad = { ...OUTPUTS, fields: { commentId: { type: "email" } } };
    expect(hIssue(journey({ outputs: bad }, ["commentId"]))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses an inputs binding that is not exactly one source", () => {
    const bad = { ...INPUTS, bindings: { replyText: {} } };
    expect(hIssue(journey({ params: ["replyText"], inputs: bad }))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses an outputs field that no extract produces, naming its path", () => {
    const j = journey({ outputs: OUTPUTS }, ["commentId", "account"]);
    expect(hPaths(j)).toContainEqual(["metadata", "outputs", "fields", "sourceText"]);
  });

  it("refuses an outputs.key naming an undeclared field", () => {
    const bad = { ...OUTPUTS, key: ["commentId", "ghost"] };
    expect(hIssue(journey({ outputs: bad }, ["commentId", "account", "sourceText"]))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses an outputs.key naming a non-id field", () => {
    const bad = { ...OUTPUTS, key: ["sourceText"] };
    expect(hIssue(journey({ outputs: bad }, ["commentId", "account", "sourceText"]))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses a binding to an undeclared param", () => {
    const bad = { ...INPUTS, bindings: { ghost: { const: "x" } } };
    expect(hIssue(journey({ inputs: bad }))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses a required run param with no binding", () => {
    const j = {
      metadata: {
        id: "j", name: "j", promoted: false, params: ["who"], createdAtIso: "2026-01-01T00:00:00Z",
        inputs: { ...INPUTS, bindings: { replyText: { request: "replyText" } } },
      },
      recording: {
        version: "1", site: "example",
        pages: [{ url: "/", steps: [{ step: { kind: "fill", target: { css: "#u" }, value: { var: "who" }, expect: { kind: "urlIncludes", text: "/" } }, variableName: "who" }] }],
      },
    };
    expect(hIssue(j).some((m) => m.includes("who"))).toBe(true);
  });

  it("refuses a secret param bound to a record", () => {
    const j = journey({ parameters: [{ name: "sessionToken", secret: true }], inputs: { ...INPUTS, bindings: { sessionToken: { record: "commentId" } } } });
    expect(hIssue(j)[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses a non-secret param bound to a secret", () => {
    const bad = { ...INPUTS, bindings: { replyIdentity: { secret: "op-ref" } } };
    expect(hIssue(journey({ params: ["replyIdentity"], inputs: bad }))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses a request binding to an undeclared request field", () => {
    const bad = { ...INPUTS, bindings: { commentId: { request: "ghost" } } };
    expect(hIssue(journey({ params: ["commentId"], inputs: bad }))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });

  it("refuses a request.key that is not a subset of the request id fields", () => {
    const bad = { ...INPUTS, request: { ...REQUEST, key: ["replyText"] }, bindings: { replyText: { request: "replyText" } } };
    expect(hIssue(journey({ params: ["replyText"], inputs: bad }))[0]).toMatch(/^E_HANDOFF_SCHEMA/);
  });
});

describe("validateFieldValue id", () => {
  it("reports a non-string id as type", () => {
    expect(err("id", 42)).toEqual({ code: "type" });
  });
  it("reports an empty id as malformed", () => {
    expect(err("id", "")).toEqual({ code: "malformed" });
  });
  it("reports an id longer than 512 as malformed", () => {
    expect(err("id", "x".repeat(513))).toEqual({ code: "malformed" });
  });
  it("reports an id containing a control character as malformed", () => {
    expect(err("id", "a\nb")).toEqual({ code: "malformed" });
  });
  it("accepts an id with surrounding spaces byte-for-byte", () => {
    expect(err("id", " a ")).toBeNull();
  });
});

describe("validateFieldValue text", () => {
  it("reports a non-string text as type", () => {
    expect(err("text", null)).toEqual({ code: "type" });
  });
  it("reports text longer than 20000 as malformed", () => {
    expect(err("text", "x".repeat(20_001))).toEqual({ code: "malformed" });
  });
  it("accepts text with newlines verbatim", () => {
    expect(err("text", "a\nb")).toBeNull();
  });
});

describe("validateFieldValue path", () => {
  it("reports a non-string path as type", () => {
    expect(err("path", {})).toEqual({ code: "type" });
  });
  it("reports a path with no leading slash as malformed", () => {
    expect(err("path", "comments/1")).toEqual({ code: "malformed" });
  });
  it("reports a protocol-relative path as malformed", () => {
    expect(err("path", "//evil.example/x")).toEqual({ code: "malformed" });
  });
  it("reports a path with a .. segment as malformed", () => {
    expect(err("path", "/a/../b")).toEqual({ code: "malformed" });
  });
  it("reports a path longer than 2048 as malformed", () => {
    expect(err("path", `/${"x".repeat(2048)}`)).toEqual({ code: "malformed" });
  });
  it("accepts a site-relative path", () => {
    expect(err("path", "/comments/1?ref=feed")).toBeNull();
  });
});

describe("validateFieldValue url", () => {
  it("reports a non-string url as type", () => {
    expect(err("url", true)).toEqual({ code: "type" });
  });
  it("reports a non-http url as malformed", () => {
    expect(err("url", "ftp://a.example/x", { allowedOrigins: ["ftp://a.example"] })).toEqual({ code: "malformed" });
  });
  it("reports a url whose origin is not allowed as malformed", () => {
    expect(err("url", "https://evil.example/x", { allowedOrigins: ["https://a.example"] })).toEqual({ code: "malformed" });
  });
  it("accepts a url whose origin is allowed", () => {
    expect(err("url", "https://a.example/x", { allowedOrigins: ["https://a.example"] })).toBeNull();
  });
});

describe("validateFieldValue timestamp", () => {
  it("reports a non-string timestamp as type", () => {
    expect(err("timestamp", 0)).toEqual({ code: "type" });
  });
  it("reports a timestamp with an offset as malformed", () => {
    expect(err("timestamp", "2026-01-01T00:00:00+02:00")).toEqual({ code: "malformed" });
  });
  it("accepts a UTC Z timestamp", () => {
    expect(err("timestamp", "2026-01-01T00:00:00Z")).toBeNull();
  });
});

describe("readRecords", () => {
  it("reads a collection's indexed records", () => {
    const run = { "records.count": "2", "records.0.commentId": "c1", "records.0.account": "a1", "records.1.commentId": "c2", "records.1.account": "a2" };
    expect(readRecords({ ...OUTPUTS, collection: "records" }, run)).toEqual([{ commentId: "c1", account: "a1" }, { commentId: "c2", account: "a2" }]);
  });

  it("reads one flat record when outputs has no collection", () => {
    expect(readRecords(OUTPUTS, { commentId: "c1", account: "a1", sourceText: "hi" })).toEqual([{ commentId: "c1", account: "a1", sourceText: "hi" }]);
  });

  it("returns no records for a zero collection count", () => {
    expect(readRecords({ ...OUTPUTS, collection: "records" }, { "records.count": "0" })).toEqual([]);
  });
});

describe("validateRecords", () => {
  it("reports a missing required field as invalid-record", () => {
    const { rejected } = validateRecords(OUTPUTS, [{ commentId: "c1", sourceText: "hi" }]);
    expect(rejected[0]).toMatchObject({ reason: "invalid-record", errors: [{ field: "account", code: "missing" }] });
  });

  it("accepts a record whose optional field is absent", () => {
    const fields = { commentId: { type: "id" }, note: { type: "text", required: false } };
    expect(validateRecords({ contract: "x@1", fields }, [{ commentId: "c1" }]).rejected).toEqual([]);
  });

  it("reports an unknown field", () => {
    expect(validateRecords(OUTPUTS, [{ commentId: "c1", account: "a1", bogus: "x" }]).rejected[0].errors).toContainEqual({ field: "bogus", code: "unknown" });
  });

  it("reports a wrong-typed value as type", () => {
    expect(validateRecords(OUTPUTS, [{ commentId: 1, account: "a1" }]).rejected[0].errors).toContainEqual({ field: "commentId", code: "type" });
  });

  it("reports a malformed id as malformed", () => {
    expect(validateRecords(OUTPUTS, [{ commentId: "", account: "a1" }]).rejected[0].errors).toContainEqual({ field: "commentId", code: "malformed" });
  });

  it("does not include a text value in a rejection", () => {
    const text = `TOP-SECRET-${"x".repeat(20_000)}`;
    const { rejected } = validateRecords(OUTPUTS, [{ commentId: "c1", account: "a1", sourceText: text }]);
    expect(JSON.stringify(rejected)).not.toContain("TOP-SECRET");
  });

  it("reports duplicate keys as ambiguous for both records", () => {
    const rec = { commentId: "c1", account: "a1", sourceText: "hi" };
    const { rejected } = validateRecords(OUTPUTS, [rec, { ...rec }]);
    expect(rejected.map((r) => r.reason)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("detects duplicates by the default key of required id fields", () => {
    const fields = { commentId: { type: "id" }, account: { type: "id" } };
    const { rejected } = validateRecords({ contract: "x@1", fields }, [{ commentId: "c1", account: "a1" }, { commentId: "c1", account: "a1" }]);
    expect(rejected.map((r) => r.reason)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("accepts a well-formed record", () => {
    expect(validateRecords(OUTPUTS, [{ commentId: "c1", account: "a1", sourceText: "hi" }]).valid).toHaveLength(1);
  });
});

describe("checkCompatibility", () => {
  it("reports no issue when the contracts match", () => {
    expect(checkCompatibility(journey({ outputs: OUTPUTS }, ["commentId", "account", "sourceText"]) as any, journey({ params: ["commentId"], inputs: INPUTS }) as any)).toEqual([]);
  });

  it("refuses a mismatched accepts", () => {
    const to = journey({ inputs: { ...INPUTS, accepts: "community-conversation@2" } });
    expect(checkCompatibility(journey({ outputs: OUTPUTS }) as any, to as any)[0].message).toMatch(/^E_HANDOFF_INCOMPATIBLE/);
  });

  it("refuses a record binding the producing contract does not declare", () => {
    const to = journey({ inputs: { ...INPUTS, bindings: { commentId: { record: "ghost" } } } });
    expect(checkCompatibility(journey({ outputs: OUTPUTS }) as any, to as any)[0].message).toMatch(/^E_HANDOFF_INCOMPATIBLE/);
  });

  it("reports no issue when the consuming Journey declares no inputs", () => {
    expect(checkCompatibility(journey({ outputs: OUTPUTS }) as any, journey({}) as any)).toEqual([]);
  });

  it("refuses a consuming Journey when the producer declares no outputs", () => {
    expect(checkCompatibility(journey({}) as any, journey({ inputs: INPUTS }) as any)[0].message).toMatch(/^E_HANDOFF_INCOMPATIBLE/);
  });
});

describe("validateRequests", () => {
  it("reports a missing required request field as invalid-request", () => {
    const { rejected } = validateRequests(INPUTS, [{ commentId: "c1", replyText: "hi" }]);
    expect(rejected[0]).toMatchObject({ reason: "invalid-request", errors: [{ field: "account", code: "missing" }] });
  });

  it("accepts a well-formed request", () => {
    expect(validateRequests(INPUTS, [{ commentId: "c1", account: "a1", replyText: "hi" }]).valid).toHaveLength(1);
  });
});

describe("bindParams", () => {
  const decl = { ...INPUTS, bindings: { commentId: { record: "commentId" }, replyText: { request: "replyText" }, greeting: { const: "hello" }, sessionToken: { secret: "op-token" } } };
  const record = { commentId: "c1", account: "a1" };
  const request = { commentId: "c1", account: "a1", replyText: "hi" };

  it("fills a param from a record field", () => {
    expect(bindParams(decl, record, request).commentId).toBe("c1");
  });
  it("fills a param from a request field", () => {
    expect(bindParams(decl, record, request).replyText).toBe("hi");
  });
  it("fills a param from a const", () => {
    expect(bindParams(decl, record, request).greeting).toBe("hello");
  });
  it("omits a secret binding", () => {
    expect(Object.keys(bindParams(decl, record, request))).not.toContain("sessionToken");
  });
  it("omits a record binding whose field is absent", () => {
    expect(Object.keys(bindParams({ ...decl, bindings: { threadId: { record: "threadId" } } }, record, request))).not.toContain("threadId");
  });
});

describe("recordFingerprint", () => {
  it("returns a sha256-prefixed digest over the declared fields", () => {
    expect(recordFingerprint(OUTPUTS, { commentId: "c1", account: "a1", sourceText: "hi" })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is stable regardless of the record's key order", () => {
    const a = recordFingerprint(OUTPUTS, { commentId: "c1", account: "a1", sourceText: "hi" });
    const b = recordFingerprint(OUTPUTS, { sourceText: "hi", account: "a1", commentId: "c1" });
    expect(a).toBe(b);
  });

  it("changes when a declared field value changes", () => {
    expect(recordFingerprint(OUTPUTS, { commentId: "c1" })).not.toBe(recordFingerprint(OUTPUTS, { commentId: "c2" }));
  });
});
