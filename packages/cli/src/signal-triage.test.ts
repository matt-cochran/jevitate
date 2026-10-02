import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeJudgmentGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { fingerprintMarker } from "@jevitate/domain";
import type { TranscriptEntry } from "@jevitate/explore";
import { openServerLogRuntime } from "./log-correlation.js";
import { RELATED_LOGS_HEADING, SIGNAL_LIMITS, prefilter, readSignals, signalsPathFor, triageDefects, triageRunResult, writeSignals, type SignalEntry } from "./signal-triage.js";

/**
 * #313 — signal triage: the run's whole signal timeline, a code prefilter per defect, and (only with
 * a live gateway) Jev's relevance score per remaining line. Jev picks evidence, never defects.
 */

const sig = (over: Partial<SignalEntry> & Pick<SignalEntry, "text">): SignalEntry => ({ epochMs: 1_000, source: "server:file:app.log", level: "info", ...over });

const defect = { fingerprint: "0123456789abcdef", kind: "http-5xx", title: "POST /api/orders returned 500", repro: { recordingStepIndex: 2 } };

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A judge that answers every `lineN` question from `score(text)`, and records what it was asked. */
function scoringJudge(score: (text: string) => number): JudgmentPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async systemOne({ questions }) {
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(questions)) {
        const text = /«(.*)»/s.exec(q.instructions ?? "")?.[1] ?? "";
        asked.push(text);
        const p = score(text);
        out[name] = { kind: "noul", value: p >= 0.5, probability: p };
      }
      return out;
    },
  };
}

describe("prefilter (#313 step 2): code chooses the candidates", () => {
  it("keeps the lines correlated to the defect step's request apart, then its window and the step before, deduped, most severe first", () => {
    const signals: SignalEntry[] = [
      sig({ text: "GET /health ok", recordingStepIndex: 0 }),
      sig({ text: "loading cart 17", recordingStepIndex: 1, epochMs: 1_100 }),
      sig({ text: "loading cart 18", recordingStepIndex: 1, epochMs: 1_150 }), // same normalized message
      sig({ text: "plan lookup returned null for org 9", recordingStepIndex: 2, epochMs: 1_200 }),
      sig({ text: "insert failed: duplicate key", level: "error", recordingStepIndex: 2, epochMs: 1_300, request: { method: "POST", url: "/api/orders", status: 500, id: "abc" } }),
      sig({ text: "Uncaught TypeError: x is undefined", source: "pageerror", level: "error", recordingStepIndex: 2, epochMs: 1_250 }),
      sig({ text: "later step", recordingStepIndex: 3 }),
    ];
    const { byId, candidates } = prefilter(defect, signals);
    expect(byId.map((s) => s.text)).toEqual(["insert failed: duplicate key"]);
    expect(candidates.map((s) => s.text)).toEqual(["Uncaught TypeError: x is undefined", "plan lookup returned null for org 9", "loading cart 17"]);
  });

  it("a run-level defect (no step) takes the run's error/warning lines only", () => {
    const signals = [sig({ text: "info line", recordingStepIndex: 1 }), sig({ text: "boom", level: "error" }), sig({ text: "careful", level: "warn" })];
    expect(prefilter({ fingerprint: "f", kind: "hang" }, signals).candidates.map((s) => s.text)).toEqual(["boom", "careful"]);
  });

  it("caps the candidates per defect", () => {
    const many = Array.from({ length: SIGNAL_LIMITS.candidatesPerDefect * 2 }, (_, i) => sig({ text: `distinct message ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, recordingStepIndex: 2 }));
    expect(prefilter(defect, many).candidates).toHaveLength(SIGNAL_LIMITS.candidatesPerDefect);
  });
});

describe("triageDefects (#313 step 3): Jev scores relevance; code keeps the correlated lines", () => {
  const signals: SignalEntry[] = [
    sig({ text: "insert failed: duplicate key", level: "error", recordingStepIndex: 2, request: { method: "POST", url: "/api/orders", status: 500, id: "abc" } }),
    sig({ text: "plan lookup returned null for org 9", recordingStepIndex: 2, epochMs: 1_200 }),
    sig({ text: "cache warmed", recordingStepIndex: 2, epochMs: 1_210 }),
    sig({ text: "deprecated header used", level: "warn", recordingStepIndex: 2, epochMs: 1_220 }),
  ];

  it("with a gateway: the id-matched line always, plus only the lines Jev scores at or above the threshold", async () => {
    const judge = scoringJudge((t) => (t.includes("plan lookup") ? 0.9 : 0.1));
    const { byFingerprint, triage } = await triageDefects([defect], signals, { judge, secrets: [] });
    const kept = byFingerprint.get(defect.fingerprint)!;
    expect(kept.map((l) => [l.text, l.keptBy])).toEqual([
      ["insert failed: duplicate key", "request-id"],
      ["plan lookup returned null for org 9", "jev"],
    ]);
    expect(kept[1]?.score).toBe(0.9);
    // The correlated line never needed Jev; only the window's candidates were asked about.
    expect(judge.asked.sort()).toEqual(["cache warmed", "deprecated header used", "plan lookup returned null for org 9"]);
    expect(triage).toMatchObject({ mode: "jev", defects: 1, candidates: 4, kept: 2, jevCalls: 1, capped: false });
  });

  it("without a gateway (code mode): the id-matched line plus the window's error/warning lines, marked window", async () => {
    const { byFingerprint, triage } = await triageDefects([defect], signals, { secrets: [] });
    expect(byFingerprint.get(defect.fingerprint)!.map((l) => [l.text, l.keptBy])).toEqual([
      ["insert failed: duplicate key", "request-id"],
      ["deprecated header used", "window"],
    ]);
    expect(triage).toMatchObject({ mode: "code", jevCalls: 0 });
  });

  it("Jev judges each line against the defect, its step's action and the lines already tied to its request", async () => {
    const states: Array<{ goal: string; history: string[] }> = [];
    const judge: JudgmentPort = {
      async systemOne({ state, questions }) {
        states.push({ goal: state.goal, history: state.history });
        return Object.fromEntries(Object.keys(questions).map((k) => [k, { kind: "noul", value: false, probability: 0 } as Answer]));
      },
    };
    await triageDefects([{ ...defect, stepAction: 'click button "Place order" on /checkout' }], signals, { judge, secrets: [] });
    expect(states[0]?.goal).toContain("POST /api/orders returned 500");
    expect(states[0]?.history).toEqual(['the step: click button "Place order" on /checkout', "logged for the defect's request: insert failed: duplicate key"]);
  });

  it("a defect with nothing related is still reported (an empty list, never a dropped finding)", async () => {
    const { byFingerprint } = await triageDefects([defect], [], { judge: new FakeJudgmentGateway({}), secrets: [] });
    expect(byFingerprint.get(defect.fingerprint)).toEqual([]);
  });

  it("fails closed when a registered secret would reach the judgment model", async () => {
    const leaky = [sig({ text: "token hunter2 rejected", recordingStepIndex: 2 })];
    await expect(triageDefects([defect], leaky, { judge: scoringJudge(() => 1), secrets: ["hunter2"] })).rejects.toThrow();
  });
});

describe("triageRunResult: the persisted result, its drafts and the offline re-triage", () => {
  it("writes relatedLogs and the signals summary into the result file and the draft, once", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-triage-"));
    const resultPath = join(dir, "run.result.json");
    const draftPath = join(dir, "draft.md");
    await writeFile(draftPath, `# [jevitate] boom\n\nbody\n\n${fingerprintMarker(defect.fingerprint)}\n`);
    const result = { defects: [defect], issues: { drafts: [{ fingerprint: defect.fingerprint, path: draftPath }] } };
    await writeFile(resultPath, JSON.stringify({ missionOutcome: "defects-found", exitCode: 1, result }));
    writeSignals(signalsPathFor(resultPath), [sig({ text: "insert failed ```oops```", level: "error", recordingStepIndex: 2 })]);

    const updated = await triageRunResult(result, resultPath, { secrets: [] });
    expect((updated.defects[0] as { relatedLogs: unknown[] }).relatedLogs).toHaveLength(1);
    const file = JSON.parse(readFileSync(resultPath, "utf8")) as { result: { defects: Array<{ relatedLogs: unknown[] }>; signals: { entries: number; triage: { mode: string } } } };
    expect(file.result.defects[0]?.relatedLogs).toHaveLength(1);
    expect(file.result.signals).toMatchObject({ entries: 1, triage: { mode: "code" } });
    const md = readFileSync(draftPath, "utf8");
    expect(md).toContain(RELATED_LOGS_HEADING);
    expect(md.indexOf(RELATED_LOGS_HEADING)).toBeLessThan(md.indexOf(fingerprintMarker(defect.fingerprint)));
    expect(md).not.toContain("```oops```"); // a quoted line cannot close the block
    await triageRunResult(result, resultPath, { secrets: [] });
    expect(readFileSync(draftPath, "utf8").split(RELATED_LOGS_HEADING)).toHaveLength(2);
  });
});

describe("[realtime] ServerLogRuntime records the whole signal timeline with --log-triage (#313 step 1)", () => {
  const entry = (step: number): TranscriptEntry => ({ step, op: "click", target: 'button "Go"', confidence: null, chosenBy: "strategy", actOk: true, url: "http://x.test/o", signature: `s${step}`, controlCount: 1 });

  it("every backend level and the browser's console, page errors and failed requests, redacted, each in its step", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-signals-"));
    const file = join(dir, "app.log");
    await writeFile(file, "");
    const rt = openServerLogRuntime({ sources: [{ kind: "file", path: file, raw: `file:${file}` }], logDefect: [], secrets: ["s3cret"], drainMs: 500, signals: true })!;
    const page = new EventEmitter();
    rt.observe(page as never);
    await new Promise((r) => setTimeout(r, 200));
    const e = entry(1);
    rt.onTranscriptEntry(e, [e]);
    await appendFile(file, "INFO plan lookup for org 9\nDEBUG cache hit\nERROR password s3cret rejected\n");
    page.emit("console", { type: () => "log", text: () => "app booted" });
    page.emit("console", { type: () => "warning", text: () => "deprecated api" });
    page.emit("pageerror", new TypeError("x is undefined"));
    page.emit("requestfailed", { url: () => "http://x.test/api?token=abc", method: () => "POST", failure: () => ({ errorText: "net::ERR_FAILED" }) });
    const out = await rt.finish([e]);
    const signals = out.signals!;
    expect(signals.truncated).toBe(false);
    const texts = signals.entries.map((s) => `${s.source.startsWith("server:") ? "server" : s.source}|${s.level}|${s.text}`);
    expect(texts).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^server\|info\|.*plan lookup for org 9/),
        expect.stringMatching(/^server\|debug\|.*cache hit/),
        expect.stringMatching(/^server\|error\|.*password .* rejected/),
        "console|log|app booted",
        "console|warning|deprecated api",
        "pageerror|error|TypeError: x is undefined",
      ]),
    );
    expect(JSON.stringify(signals)).not.toContain("s3cret");
    expect(signals.entries.find((s) => s.source === "requestfailed")?.text).not.toContain("token=abc");
    // Off by default: no timeline is kept without --log-triage.
    const rt2 = openServerLogRuntime({ sources: [{ kind: "file", path: file, raw: `file:${file}` }], logDefect: [], secrets: [], drainMs: 1 })!;
    expect((await rt2.finish([])).signals).toBeUndefined();
  }, 15_000);

  it("round-trips through <stem>.signals.jsonl", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-signals-io-"));
    const path = signalsPathFor(join(dir, "run.result.json"));
    expect(path.endsWith("run.signals.jsonl")).toBe(true);
    writeSignals(path, [sig({ text: "a" }), sig({ text: "b", level: "error" })]);
    expect(existsSync(path)).toBe(true);
    expect(readSignals(path).map((s) => s.text)).toEqual(["a", "b"]);
  });
});

describe("--log-triage is refused without a log source (nothing ran)", () => {
  it("explore --log-triage with no --log-source is a usage error naming the missing flag", async () => {
    const { buildProgram } = await import("./program.js");
    const { ProfileManager } = await import("@jevitate/daemon");
    const out: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager("/unused") });
    program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync(["explore", "--strategy", "adversarial", "--url", "http://127.0.0.1:9/", "--log-triage", "--fake-ai", "--json"], { from: "user" });
    const env = JSON.parse(out.join("").trim().split("\n").at(-1) ?? "{}") as { ok: boolean; error?: { message: string } };
    expect(env.ok).toBe(false);
    expect(env.error?.message).toMatch(/--log-triage .* needs at least one --log-source/);
    expect(process.exitCode).toBe(64);
    process.exitCode = undefined;
  });
});

describe("#313: targets.json logTriage — the operator's opt-in for runs without a command line (queued, suites)", () => {
  it("turns triage on for that origin's queued missions; a non-boolean is refused", async () => {
    const { loadTargetsFile } = await import("./target-config.js");
    const { serverLogFromTargetConfig } = await import("./mission-queue-runner.js");
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    const file = join(dir, "targets.json");
    await writeFile(file, JSON.stringify({ "https://app.example.test": { logSources: ["docker:api-1"], logTriage: true }, "https://other.example.test": { logSources: ["docker:api-2"] } }));
    const targets = loadTargetsFile(file);
    expect(serverLogFromTargetConfig(targets, "https://app.example.test/x")?.triage).toEqual({});
    expect(serverLogFromTargetConfig(targets, "https://other.example.test/")?.triage).toBeUndefined();
    await writeFile(file, JSON.stringify({ "https://app.example.test": { logSources: ["docker:api-1"], logTriage: "yes" } }));
    expect(() => loadTargetsFile(file)).toThrow(/logTriage must be true or false/);
  });

  it("Jev scores only on live gateways: a fake run triages by code", async () => {
    const { triagedServerLog } = await import("./explore-shared.js");
    const judge = new FakeJudgmentGateway({});
    const base = { sources: [], logDefect: [], triage: {} };
    expect(triagedServerLog(base, judge, true).serverLog?.triage?.judge).toBe(judge);
    expect(triagedServerLog(base, judge, false).serverLog?.triage?.judge).toBeUndefined();
    expect(triagedServerLog({ sources: [], logDefect: [] }, judge, true).serverLog?.triage).toBeUndefined();
  });
});
