import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort } from "@jevitate/playwright";
import { buildProgram, type CliDeps } from "./program.js";
import { commandPath } from "./cli-refusal.js";

/**
 * #218: EVERY registered command refuses unusable input the same way — exit 64 (usage), a human
 * `error …` line on stderr and nothing on stdout without `--json`; exactly one `{ok:false}` envelope
 * line on stdout with it. The commands are enumerated from `buildProgram`, so a new command (or a
 * new numeric flag) fails this test until its refusal paths are declared below.
 */

let dir: string;
let missing: string;
let validRecording: string;
let validScript: string;
let badProduct: string;
let suiteOffAllowlist: string;
let suiteUnknownFingerprint: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cli-refusal-"));
  missing = join(dir, "missing.json");
  validRecording = join(dir, "flow.recording.json");
  writeFileSync(
    validRecording,
    JSON.stringify({
      version: "1.0",
      site: "https://shop.test",
      pages: [{ url: "https://shop.test/catalog", steps: [{ step: { kind: "click", target: { role: "link", name: "Widgets" }, expect: { kind: "visible", target: { testId: "list" } } } }] }],
    }),
  );
  // #198: a product facts file with a negative price and an unknown key.
  badProduct = join(dir, "product.json");
  writeFileSync(badProduct, JSON.stringify({ version: 1, plans: [{ name: "Pro", prices: [{ amount: -1, interval: "month" }] }], extra: true }));
  validScript = join(dir, "script.json");
  writeFileSync(validScript, JSON.stringify([{ kind: "click", label: "open menu" }]));
  // A mission whose start URL (the target's own) is off the target's `allow` list, and a verifyFix
  // whose fingerprint its result does not hold: refused up front like a missing result file.
  suiteOffAllowlist = join(dir, "off-allowlist.suite.json");
  writeFileSync(
    suiteOffAllowlist,
    JSON.stringify({ version: 1, ai: "fake", targets: [{ name: "t", url: "http://127.0.0.1:3999/", allow: ["http://other.test"], missions: [{ strategy: "coverage" }] }] }),
  );
  const result = join(dir, "adversarial.result.json");
  writeFileSync(
    result,
    JSON.stringify({ missionOutcome: "clean", exitCode: 0, result: { strategy: "adversarial", target: { seedUrl: "http://127.0.0.1:3999/", allowlist: ["http://127.0.0.1:3999"] }, defects: [], hangs: [] } }),
  );
  suiteUnknownFingerprint = join(dir, "unknown-fp.suite.json");
  writeFileSync(
    suiteUnknownFingerprint,
    JSON.stringify({ version: 1, ai: "fake", targets: [{ name: "t", url: "http://127.0.0.1:3999/", verifyFix: [{ result, fingerprint: "0123456789abcdef" }] }] }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  process.exitCode = undefined;
});

/** A browser port that refuses to open: a command that gets past its input checks fails at runtime (2). */
const refusingPort: BrowserPort = {
  async open() {
    throw new Error("open intercepted by test");
  },
};

function deps(): CliDeps {
  return {
    profiles: new ProfileManager(join(dir, "profiles")),
    dbPath: join(dir, "site.sqlite"),
    journeysDir: join(dir, "journeys"),
    missionTargetsDir: join(dir, "targets"),
    inboxDir: join(dir, "inbox"),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => refusingPort },
    missions: {
      execute: async () => {
        throw new Error("mission executor intercepted by test");
      },
    },
    sources: {
      sourcesDir: join(dir, "sources"),
      lockPath: join(dir, "jevitate.lock"),
      trustDir: join(dir, "trust"),
      ackDir: join(dir, "ack"),
      git: async () => {
        throw new Error("git intercepted by test");
      },
    },
    ui: {
      startUiServer: async () => {
        throw new Error("ui server intercepted by test");
      },
    },
  } as CliDeps;
}

async function run(argv: readonly string[]): Promise<{ code: number | undefined; out: string; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram(deps());
  program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  let code: number | undefined;
  try {
    await program.parseAsync([...argv], { from: "user" });
    code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    code = err.exitCode;
  }
  return { code, out: stdout.join(""), err: stderr.join("") };
}

function leaves(program: Command): Command[] {
  return program.commands.flatMap((c) => (c.commands.length === 0 ? [c] : leaves(c)));
}

const URL0 = "http://127.0.0.1:3999/";
const FP = "0123456789abcdef";

interface Refusals {
  /**
   * A minimal invocation (after the command path) that passes the command's own argument checks,
   * so a bad numeric option is refused by ITS validation, not by an unrelated missing flag.
   */
  readonly base?: readonly string[];
  /** Invocations (after the command path) that must be refused as unusable input. */
  readonly cases: ReadonlyArray<readonly string[]>;
}

/** #221: names that try to leave their root (each must be refused, never joined into a path). */
const TRAVERSAL = (): string[] => ["../x", "a/../../x", join(dir, "outside-root"), "..\\x", "..", "x\u0000y", "a".repeat(200)];

/** Every leaf command, by path: its refusal paths, or why it has none beyond commander's own parse errors. */
const REFUSALS = (): Readonly<Record<string, Refusals | { readonly exempt: string }>> => ({
  init: { exempt: "no file, id or number input: it detects and writes" },
  // #221: a name is one safe path segment — never a path out of the profiles root.
  "profile create": { cases: TRAVERSAL().map((n) => [n]) },
  "profile status": { cases: TRAVERSAL().map((n) => [n]) },
  "site policy get": { exempt: "reports an unset policy as a status (exit 0), not a refusal" },
  "site policy set": { cases: [["x", "--file", missing, "--db", join(dir, "site.sqlite")]] },
  "site simulate": { base: ["x", "--script", validScript, "--db", join(dir, "site.sqlite")], cases: [["x", "--script", missing]] },
  "recording promote": { base: [validRecording, "--page", "0", "--step", "0", "--var", "v"], cases: [[missing, "--page", "0", "--step", "0", "--var", "v"]] },
  "recording diff": { cases: [[missing, missing]] },
  "recording fit": { cases: [[missing]] },
  "recording postdoc": { cases: [[missing]] },
  "journey list": { exempt: "a listing: an empty or missing dir lists nothing" },
  "journey find": { exempt: "a search: no match is an empty result" },
  "journey run": { base: ["nope"], cases: [["nope"], ["nope", "--storage-state", missing]] },
  "journey promote": { cases: [["nope"]] },
  "journey annotate": {
    base: ["nope", "--fake-ai"],
    cases: [["nope", "--fake-ai"], ["nope", "--fake-ai", "--storage-state", missing], ["nope", "--approve"], ["nope", "--approve", "--fake-ai"]],
  },
  "journey demo": {
    base: ["nope"],
    cases: [["nope"], ["nope", "--storage-state", missing], ["nope", "--video", join(dir, "demo.mp4")], ["nope", "--guide", join(dir, "guide.txt")]],
  },
  "journey publish": { cases: [["nope", "--to", "nowhere"]] },
  "source add": { exempt: "its input is a remote git URL: a failed clone is a runtime failure (2)" },
  "source list": { exempt: "a listing" },
  "source pull": { cases: [["nope"]] },
  "source update": { cases: [["nope"]] },
  "source remove": { cases: [["nope"]] },
  "source trust": { cases: [["nope", "j"]] },
  "source run": { cases: [["nope", "j"]] },
  "load run": { base: ["nope", "--authorized-origin", URL0], cases: [["nope", "--authorized-origin", URL0]] },
  explore: {
    base: ["--url", URL0, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--out", join(dir, "explore")],
    cases: [
      ["--url", URL0, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--storage-state", missing],
      ["--url", URL0, "--strategy", "coverage", "--fake-ai", "--invariants", missing],
      // #225: usability honours --success — so an unparseable one (or --success-when without one) is refused, never ignored.
      ["--url", URL0, "--strategy", "usability", "--goal", "g", "--app-class", "consumer", "--fake-ai", "--success", "nonsense:x"],
      ["--url", URL0, "--strategy", "usability", "--goal", "g", "--app-class", "consumer", "--fake-ai", "--success-when", "held"],
      // #198: --product is validated before a browser opens, and refused outside usability.
      ["--url", URL0, "--strategy", "usability", "--goal", "g", "--app-class", "consumer", "--fake-ai", "--product", badProduct],
      ["--url", URL0, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--product", badProduct],
      ["--url", URL0, "--strategy", "coverage", "--fake-ai", "--polish"],
      ["--url", URL0, "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--probe-guards"],
      // #225: a strategy that does not honour success checks refuses them — never silently ignored.
      ...["coverage", "exploratory", "adversarial"].flatMap((strategy) => [
        ["--url", URL0, "--strategy", strategy, "--fake-ai", "--success", "urlIncludes:/x"],
        ["--url", URL0, "--strategy", strategy, "--fake-ai", "--success-when", "held"],
        ["--url", URL0, "--strategy", strategy, "--fake-ai", "--allow-vacuous-checks"],
      ]),
      ["--url", URL0, "--feature", "home", "--success", "urlIncludes:/x"],
    ],
  },
  "verify-fix": { base: ["--result", missing, "--fingerprint", FP], cases: [["--result", missing, "--fingerprint", FP], []] },
  "ledger add": { cases: [[missing, FP, "--dir", join(dir, "ledger")]] },
  "ledger list": { exempt: "a listing" },
  "ledger verify": { base: [FP, "--dir", join(dir, "ledger")], cases: [[FP, "--dir", join(dir, "ledger")], ["not-a-fingerprint", "--dir", join(dir, "ledger")]] },
  "explore-author-journey": {
    base: ["--url", URL0, "--goal", "g", "--success", "urlIncludes:/x", "--id", "a", "--name", "a", "--fake-ai"],
    cases: [["--url", URL0, "--goal", "g", "--success", "urlIncludes:/x", "--id", "a", "--name", "a", "--fake-ai", "--storage-state", missing]],
  },
  // #249: --success and a named (non-production) --env are required; a bad spec / unknown env is refused.
  "demo create": {
    base: ["x", "--success", "urlIncludes:/x", "--fake-ai"],
    cases: [["x", "--fake-ai"], ["x", "--success", "urlIncludes:/x", "--fake-ai"], ["x", "--success", "nonsense:x", "--env", "nope"], ["x", "--success", "urlIncludes:/x", "--env", "nope"]],
  },
  "demo approve": { cases: [["nope"], ["../x"]] },
  record: { cases: [["--url", "not-a-url"]] },
  "regression capture": {
    base: ["--from", missing, "--id", "x", "--dir", join(dir, "regressions")],
    cases: [["--from", missing, "--id", "x", "--dir", join(dir, "regressions")], ...TRAVERSAL().map((n) => ["--from", validRecording, "--id", n, "--dir", join(dir, "regressions")])],
  },
  "regression run": { base: ["nope", "--dir", join(dir, "regressions")], cases: [["nope", "--dir", join(dir, "regressions")], ...TRAVERSAL().map((n) => [n, "--dir", join(dir, "regressions")])] },
  "mission target add": { cases: [["x"]] },
  "mission target update": { cases: [["nope", "--clear-auth"]] },
  "mission target list": { exempt: "a listing" },
  "mission target promote": { cases: [["nope"]] },
  "mission run": { base: ["--once", "--fake-ai"], cases: [["--once", "--watch"]] },
  // #254: MCP queue_exploration / get_mission_result — the facade's refusals, as 64.
  "mission queue": {
    base: ["nope", "--strategy", "coverage", "--dir", join(dir, "queue")],
    cases: [["nope", "--strategy", "coverage", "--dir", join(dir, "queue")], ["nope", "--dir", join(dir, "queue")], ["nope", "--strategy", "bogus"], ["nope", "--strategy", "coverage", "--invariants", missing]],
  },
  "mission result": { cases: [["nope"], ["../x"], ["explore-2026-01-01T00-00-00-000Z", "--results-dir", join(dir, "results")]] },
  // #254: MCP inbox tools — unknown/unsafe ids, missing fields; approve/cancel are always refused (human-only).
  "inbox list": { exempt: "a listing" },
  "inbox health": { exempt: "a status report" },
  "inbox show": { cases: [["nope"], ["../x"]] },
  "inbox command": { cases: [["nope"], ["../x"]] },
  "inbox queue-retrieval": { cases: [[], ["--run", "r", "--journey", "j", "--step", "s", "--reason", "x", "--agent", "a", "--findings", missing]] },
  "inbox queue-action": { cases: [[], ["--run", "r", "--journey", "j", "--step", "s", "--reason", "x", "--agent", "a", "--kind", "bogus"]] },
  "inbox approve": { cases: [["x"]] },
  "inbox cancel": { cases: [["x"]] },
  mcp: { cases: [["--print-config", "bogus"]] },
  ui: { exempt: "no file or id input (its --port is covered by the numeric sweep)" },
  ux: {
    base: [validRecording, "--app-class", "consumer", "--fake-ai", "--out", join(dir, "ux")],
    cases: [
      [missing, "--app-class", "consumer", "--fake-ai"],
      [validRecording, "--fake-ai"],
      // #198: a missing or invalid product facts file is refused before any analysis.
      [validRecording, "--app-class", "consumer", "--fake-ai", "--product", missing],
      [validRecording, "--app-class", "consumer", "--fake-ai", "--product", badProduct],
    ],
  },
  "ai status": { exempt: "a status report" },
  "ai setup": { cases: [["bogus"]] },
  "ai generate": { cases: [["bogus", "--input", "{}"]] },
  check: {
    cases: [
      ["--suite", missing, "--out", join(dir, "check")],
      ["--suite", suiteOffAllowlist, "--out", join(dir, "check")],
      ["--suite", suiteUnknownFingerprint, "--out", join(dir, "check")],
    ],
  },
  report: { cases: [["--since", "not-a-run-or-date"]] },
  diff: { cases: [[missing, missing]] },
  "baseline tag": { cases: [["x", missing]] },
  "baseline list": { exempt: "a listing" },
  "baseline show": { cases: [["nope"]] },
  "logs prune": { exempt: "housekeeping: a missing logs dir has nothing to prune" },
  "invariants validate": { cases: [[missing]] },
  doctor: { exempt: "#205: a diagnostic with no file or id input (it reports and, with --cleanup, cleans; nothing to refuse)" },
});

/** Numeric placeholders: every such option is parsed by a cli-args.ts argParser … */
const NUMERIC = /<(n|ms|k|ratio|seconds)>/;
/** … except these, validated (before anything runs) by a resolver their env/config/suite forms share. */
const VALIDATED_IN_ACTION = new Set([
  "site simulate --seed", // E_INVALID_SEED
  "explore --repeat", // resolveMultiRunPlan
  "explore --min-agreement",
  "explore --min-confidence", // ux-config (JEVITATE_UX_MIN_CONFIDENCE / config.json)
  "explore --max-findings-per-page",
  "ux --min-confidence",
  "ux --max-findings-per-page",
]);

/** The base needed to reach an in-action validation that only one strategy runs. */
const NUMERIC_BASE: Readonly<Record<string, readonly string[]>> = {
  "explore --min-confidence": ["--url", URL0, "--strategy", "usability", "--goal", "g", "--app-class", "consumer", "--fake-ai"],
  "explore --max-findings-per-page": ["--url", URL0, "--strategy", "usability", "--goal", "g", "--app-class", "consumer", "--fake-ai"],
};

function expectHumanRefusal(r: { code: number | undefined; out: string; err: string }, what: string): void {
  expect(r.code, `${what}: exit code (stderr: ${r.err})`).toBe(64);
  expect(r.out, `${what}: stdout stays empty without --json`).toBe("");
  expect(r.err, `${what}: a human error line on stderr`).toMatch(/^error[ :]/m);
  expect(r.err, `${what}: never raw JSON`).not.toMatch(/^\{/m);
}

function expectJsonRefusal(r: { code: number | undefined; out: string; err: string }, what: string): void {
  expect(r.code, `${what} --json: exit code`).toBe(64);
  const lines = r.out.trimEnd().split("\n");
  expect(lines, `${what} --json: exactly one envelope line`).toHaveLength(1);
  expect(JSON.parse(lines[0]!), `${what} --json: a refusal envelope`).toMatchObject({ v: 1, ok: false, error: { code: expect.any(String) } });
}

const hasJson = (cmd: Command): boolean => cmd.options.some((o) => o.long === "--json");

describe("#218: every command refuses unusable input with 64 and a human error (enumerated from buildProgram)", () => {
  const program = buildProgram({ profiles: new ProfileManager(join(tmpdir(), "jev-cli-refusal-unused")) });
  const commands = leaves(program);

  it("every registered command declares its refusal paths (or why it has none)", () => {
    const declared = Object.keys(REFUSALS());
    const registered = commands.map(commandPath);
    expect(registered.filter((p) => !declared.includes(p)), "commands with no REFUSALS entry").toEqual([]);
    expect(declared.filter((p) => !registered.includes(p)), "stale REFUSALS entries").toEqual([]);
  });

  it("#221: a traversal profile name or regression id creates nothing outside its root", async () => {
    for (const argv of [["profile", "create", "../x"], ["profile", "create", "a/../../x"], ["profile", "create", join(dir, "outside-root")]]) {
      expect((await run(argv)).code, argv.join(" ")).toBe(64);
    }
    expect(existsSync(join(dir, "x"))).toBe(false);
    expect(existsSync(join(dir, "outside-root"))).toBe(false);
  });

  it("every numeric option is parsed at parse time (a cli-args.ts argParser) or validated before anything runs", () => {
    const unparsed = commands.flatMap((cmd) =>
      cmd.options
        .filter((o) => NUMERIC.test(o.flags) && o.parseArg === undefined)
        .map((o) => `${commandPath(cmd)} ${o.long ?? o.flags}`)
        .filter((key) => !VALIDATED_IN_ACTION.has(key)),
    );
    expect(unparsed).toEqual([]);
  });

  for (const cmd of commands) {
    const path = commandPath(cmd);
    const tokens = path.split(" ");
    const numeric = cmd.options.filter((o) => NUMERIC.test(o.flags));

    for (const opt of numeric) {
      it(`${path} ${opt.long}: a non-number is a usage error (64)`, async () => {
        const entry = REFUSALS()[path];
        const base = NUMERIC_BASE[`${path} ${opt.long}`] ?? (entry !== undefined && "cases" in entry ? (entry.base ?? []) : []);
        const argv = [...tokens, ...base, opt.long!, "abc"];
        expectHumanRefusal(await run(argv), argv.join(" "));
        if (hasJson(cmd)) expectJsonRefusal(await run([...argv, "--json"]), argv.join(" "));
      });
    }

    it(`${path}: refusals are 64 with a human error on stderr (the envelope only with --json)`, async () => {
      const entry = REFUSALS()[path];
      expect(entry, `${path} has a REFUSALS entry`).toBeDefined();
      if (entry === undefined || "exempt" in entry) return;
      expect(entry.cases.length, `${path} declares at least one refusal`).toBeGreaterThan(0);
      for (const c of entry.cases) {
        const argv = [...tokens, ...c];
        expectHumanRefusal(await run(argv), argv.join(" "));
        if (hasJson(cmd)) expectJsonRefusal(await run([...argv, "--json"]), argv.join(" "));
      }
    });
  }
});

/**
 * #227: extends the walk above to a command's SUCCESS path — without --json, it must be human text,
 * never the raw `{v, ok, data}` envelope (regression #1/#2 of #227: `regression capture`/`run` and
 * `baseline tag`/`show`/`list` used to print it unconditionally; `journey list`/`source list` on an
 * empty dir printed nothing at all). Limited to the "a listing" REFUSALS-exempt commands — the ones
 * that succeed with no fixture beyond an empty tmp dir, so this needs no browser/model/network.
 */
describe("#227: a listing command's SUCCESS output without --json is human text, never JSON", () => {
  // A function, like `REFUSALS()` above: `dir` (module-level `let`) is only assigned in `beforeAll`,
  // after this describe block's own body already ran at collection time.
  const LISTINGS = (): ReadonlyArray<{ readonly path: string; readonly argv: readonly string[] }> => [
    { path: "journey list", argv: ["journey", "list", "--dir", join(dir, "journeys-empty")] },
    { path: "source list", argv: ["source", "list"] },
    { path: "ledger list", argv: ["ledger", "list", "--dir", join(dir, "ledger-empty")] },
    { path: "mission target list", argv: ["mission", "target", "list", "--dir", join(dir, "targets-empty")] },
    { path: "inbox list", argv: ["inbox", "list", "--inbox-dir", join(dir, "inbox-empty")] },
  ];

  for (const path of ["journey list", "source list", "ledger list", "mission target list", "inbox list"]) {
    it(`${path}: success without --json is human text, never raw JSON`, async () => {
      const argv = LISTINGS().find((l) => l.path === path)!.argv;
      const r = await run(argv);
      expect(r.code, `${path}: exit code`).toBe(0);
      expect(r.err, `${path}: nothing on stderr`).toBe("");
      expect(r.out, `${path}: never raw JSON`).not.toMatch(/^\{/m);
      const withJson = await run([...argv, "--json"]);
      expect(withJson.code, `${path} --json: exit code`).toBe(0);
      expect(() => JSON.parse(withJson.out), `${path} --json: exactly one envelope line`).not.toThrow();
    });
  }

  it("journey list / source list: an empty listing is a next-step line, never silence (#227 item 2)", async () => {
    const journeys = await run(["journey", "list", "--dir", join(dir, "journeys-empty-2")]);
    expect(journeys.out).toBe("no journeys yet — record one with `jevitate record` (see jevitate record --help)\n");
    const sources = await run(["source", "list"]);
    expect(sources.out).toBe("no sources yet — add one with `jevitate source add <name> <gitUrl>`\n");
  });
});
