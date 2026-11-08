import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APPROVAL_CHANNELS } from "@jevitate/journey";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EvidenceApprovalChannelSchema,
  KnownSchema,
  RunEvidenceSchema,
  WriteShapeSchema,
  type RunEvidence,
} from "./evidence.js";

const writes = () => ({
  sent: { known: true, value: 2 },
  answered: { known: true, value: 2 },
  aborted: { known: true, value: 0 },
  openAtClose: { known: true, value: 0 },
  shapes: [{ step: 2, method: "POST", path: "/api/todos", count: 2, status: { known: true, value: "2xx" } }],
});

const reading = (value: boolean, at: "pre" | "post") => ({ value: { known: true, value }, session: "fresh", at, durationMs: 840 });

/** Every section present, so each level's strictness is exercised. */
function fixture(): RunEvidence {
  return {
    schema: "jevitate.evidence",
    version: 1,
    producedAt: "2026-11-08T12:00:00.000Z",
    producer: { jevitate: "0.30.0", commit: "b097a84" },
    subject: {
      kind: "mutation-proof",
      journey: { id: "add-todo", hash: "sha256:abc" },
      job: { id: "keep-a-list", hash: "sha256:def" },
      goalDigest: "hmac:123",
    },
    run: {
      mode: "test",
      channel: "cli",
      target: { origin: "http://127.0.0.1:4173", environment: "local", trust: "test" },
      paramsDigest: "hmac:456",
      secretParamNames: ["password"],
      approval: { channel: "tty", contentHash: "sha256:789" },
    },
    steps: [
      { index: 1, kind: "navigate", outcome: "ok", postcondition: "none", writes: { known: true, value: 0 } },
      { index: 2, kind: "click", outcome: "ok", postcondition: "held", writes: { known: true, value: 2 } },
      { index: 3, kind: "click", outcome: "refused", postcondition: { known: false, reason: "page-replaced" }, writes: { known: false, reason: "not-gathered" }, refusal: "E_RUN_REFUSED_DESTRUCTIVE" },
    ],
    writes: writes(),
    doneCheck: {
      spec: { version: 1, at: "/todos?q=${title}", check: "textIncludes:${title}", session: "fresh", distinguishedBy: ["title"] },
      before: reading(false, "pre"),
      after: reading(true, "post"),
      inRun: { value: { known: false, reason: "check-unevaluable" }, session: "run", at: 2, durationMs: 12 },
    },
    mutation: {
      plan: {
        mutations: [{ id: "m1", kind: "block-write", step: 2 }, { id: "m2", kind: "swap-param", step: 1, param: "title" }],
        pairs: [{ site: "step:2", mutation: "m1", declared: true }],
        sites: [{ site: "step:2", check: "postcondition", required: true }],
      },
      replays: [
        { ordinal: 0, role: "base", outcome: "passed", failedSites: [], writes: writes() },
        {
          ordinal: 1,
          role: "mutated",
          mutation: "m1",
          relaxedSites: ["step:1"],
          outcome: "failed",
          failedSites: [
            { where: "step", step: 2, postcondition: true, evaluated: true },
            { where: "step-request", step: 2, checkIndex: 0 },
            { where: "end-state", index: 0 },
            { where: "unevaluable" },
          ],
          writes: writes(),
          waitsCut: ["step:2"],
          reused: true,
          retries: [{ reason: "replay stalled at close; retried once" }],
        },
      ],
      restore: "ok",
      isolation: { known: true, value: "isolated" },
    },
    boundary: { kind: "off-allowlist", step: 3, origin: "https://pay.example.com", signal: "write-refused" },
    judgments: [{ advisory: true, task: "done.grounded", step: 3, probability: 0.92, threshold: 0.8 }],
    notes: ["done check read false before and true after"],
  } as RunEvidence;
}

type Json = Record<string, unknown>;

/** Every object path in a value, so an extra key can be planted at each level. */
function objectPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => objectPaths(v, [...path, i]));
  if (value === null || typeof value !== "object") return [];
  return [path, ...Object.entries(value).flatMap(([k, v]) => objectPaths(v, [...path, k]))];
}

function at(root: unknown, path: (string | number)[]): Json {
  return path.reduce<unknown>((node, key) => (node as Json)[key], root) as Json;
}

describe("RunEvidence v1 schema", () => {
  it("parses a complete fixture unchanged", () => {
    const evidence = fixture();
    expect(RunEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it("refuses an extra key at every object level", () => {
    const paths = objectPaths(fixture());
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) {
      const evidence = fixture();
      at(evidence, path)["extra"] = "x";
      expect(RunEvidenceSchema.safeParse(evidence).success, `extra key at /${path.join("/")}`).toBe(false);
    }
  });

  it("refuses a reason over 500 characters", () => {
    const long = "x".repeat(501);
    const retry = fixture();
    (retry.mutation!.replays[1]!.retries as { reason: string }[])[0]!.reason = long;
    expect(RunEvidenceSchema.safeParse(retry).success).toBe(false);
    const note = fixture();
    (note.notes as string[])[0] = long;
    expect(RunEvidenceSchema.safeParse(note).success).toBe(false);
    const unknown = fixture();
    (unknown.steps[2] as Json)["writes"] = { known: false, reason: long };
    expect(RunEvidenceSchema.safeParse(unknown).success).toBe(false);
    const ok = fixture();
    (ok.notes as string[])[0] = "x".repeat(500);
    expect(RunEvidenceSchema.safeParse(ok).success).toBe(true);
  });

  it("refuses a value on a WriteShape: shape only, never values", () => {
    const shape = { ...fixture().writes.shapes[0]!, value: "hunter2" };
    expect(WriteShapeSchema.safeParse(shape).success).toBe(false);
    const evidence = fixture();
    (evidence.writes.shapes[0] as Json)["value"] = "hunter2";
    expect(RunEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it("refuses openAtClose as a bare number", () => {
    const evidence = fixture();
    (evidence.writes as Json)["openAtClose"] = 0;
    expect(RunEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it("refuses a target origin that carries a path or query", () => {
    const evidence = fixture();
    (evidence.run.target as Json)["origin"] = "https://app.example.com/login?token=abc";
    expect(RunEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it("keeps known zero and unknown distinct", () => {
    const schema = KnownSchema(z.number().int().nonnegative());
    const zero = schema.parse({ known: true, value: 0 });
    const unknown = schema.parse({ known: false, reason: "page-not-watched" });
    expect(zero).not.toEqual(unknown);
    expect(schema.safeParse({ known: true }).success).toBe(false);
    expect(schema.safeParse({ known: false }).success).toBe(false);
  });

  it("mirrors the approval channels of @jevitate/journey", () => {
    expect(EvidenceApprovalChannelSchema.options).toEqual([...APPROVAL_CHANNELS]);
  });

  it("bounds every string in the schema source", () => {
    const source = readFileSync(fileURLToPath(new URL("./evidence.ts", import.meta.url)), "utf8").split("\n");
    const strings = source.filter((line) => line.includes("z.string()"));
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((line) => !line.includes(".max("))).toEqual([]);
    expect(source.filter((line) => line.includes(".max(")).length).toBe(strings.length);
  });
});
