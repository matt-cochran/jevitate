import { beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { RecordedStep, Recording } from "@jevitate/recording";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";

/**
 * #566 `jevitate recording propose` (CLI) and the MCP `recordings` tool's `propose` action, over two
 * fictional take files of a comment-reply flow: sign in (username + password), open a thread page
 * whose header carries `data-thread-id`, fill the reply, choose the account, click Send. The
 * password is deliberately captured as a value (a mis-recorded secret) — it must never come back.
 * Also: the MCP `diff`/`postdoc` actions never hand a captured value to the model.
 */

const PASSWORD = "Hunter2-correct-horse";
const REPLY_A = "Thanks — we refunded the duplicate charge.";
const REPLY_B = "Your parcel ships on Monday.";
const USERNAME = "agent@example.test";

interface TakeSpec {
  thread: string;
  subject: string;
  reply: string;
  account: string;
  send?: boolean;
}

function take(t: TakeSpec): { recording: Recording; values: Record<string, string> } {
  const thread: RecordedStep[] = [
    {
      stepId: "s-open",
      step: {
        kind: "navigate",
        url: `https://app.example.test/threads/${t.thread}`,
        expect: { kind: "attr", target: { testId: "thread-header" }, name: "data-thread-id", value: t.thread },
      },
    },
    { stepId: "s-subj", step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "thread-subject" }, text: t.subject } } },
    {
      stepId: "s-reply",
      step: { kind: "fill", target: { label: "Reply" }, value: { redacted: true, length: t.reply.length }, expect: { kind: "valueEquals", target: { label: "Reply" }, value: t.reply } },
    },
    {
      stepId: "s-account",
      step: { kind: "select", target: { label: "Account" }, value: { redacted: true, length: t.account.length }, expect: { kind: "visible", target: { label: "Account" } } },
    },
    ...(t.send === false
      ? []
      : [{ stepId: "s-send", step: { kind: "click", target: { role: "button", name: "Send" }, expect: { kind: "visible", target: { testId: "sent-toast" } } } } satisfies RecordedStep]),
  ];
  const recording: Recording = {
    version: "1.0",
    site: "https://app.example.test",
    intent: "Reply to a support thread",
    startedAtIso: "2026-10-17T00:00:00.000Z",
    pages: [
      {
        url: "https://app.example.test/login",
        steps: [
          { stepId: "s-user", step: { kind: "fill", target: { label: "Username" }, value: { redacted: true, length: USERNAME.length }, expect: { kind: "visible", target: { label: "Username" } } } },
          { stepId: "s-pass", step: { kind: "fill", target: { label: "Password" }, value: { redacted: true, length: PASSWORD.length }, expect: { kind: "visible", target: { label: "Password" } } } },
          { stepId: "s-signin", step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "urlIncludes", text: "/threads" } } },
        ],
      },
      { url: `https://app.example.test/threads/${t.thread}`, steps: thread },
    ],
  };
  return { recording, values: { "s-user": USERNAME, "s-pass": PASSWORD, "s-reply": t.reply, "s-account": t.account } };
}

const TAKE_A: TakeSpec = { thread: "T-1042", subject: "Billing question", reply: REPLY_A, account: "acct-support" };
const TAKE_B: TakeSpec = { thread: "T-2077", subject: "Shipping delay", reply: REPLY_B, account: "acct-billing" };

let root: string;
let takeA: string;
let takeB: string;
let noSendA: string;
let noSendB: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "jevitate-566-propose-"));
  takeA = join(root, "take-a.json");
  takeB = join(root, "take-b.json");
  noSendA = join(root, "nosend-a.json");
  noSendB = join(root, "nosend-b.json");
  await writeFile(takeA, JSON.stringify(take(TAKE_A)));
  await writeFile(takeB, JSON.stringify(take(TAKE_B)));
  await writeFile(noSendA, JSON.stringify(take({ ...TAKE_A, send: false })));
  await writeFile(noSendB, JSON.stringify(take({ ...TAKE_B, send: false })));
});

let runs = 0;
/** A fresh journeys store per call (unless one is given). */
function freshJourneysDir(): string {
  runs += 1;
  return join(root, `journeys-${runs}`);
}

async function cli(args: string[], journeysDir = freshJourneysDir()): Promise<{ out: string; exitCode: number | undefined; journeysDir: string }> {
  const out: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir });
  const override = (c: Command): void => {
    c.exitOverride();
    c.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => out.push(s) });
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { out: out.join(""), exitCode, journeysDir };
}

interface ProposeData {
  params: Array<{ name: string }>;
  ambiguities: Array<{ kind: string; stepIds: string[] }>;
  draft?: { id: string; path: string };
}
const dataOf = (out: string): ProposeData => (JSON.parse(out) as { data: ProposeData }).data;

async function savedDraft(journeysDir: string, id = "proposed-draft"): Promise<Journey | null> {
  return new FsJourneyStore(journeysDir).get(id);
}

describe("recording propose (CLI)", () => {
  test("exits 0 for two takes of the same flow", async () => {
    expect((await cli(["recording", "propose", takeA, takeB, "--json"])).exitCode).toBe(0);
  });

  test("proposes the thread, reply and account as parameters in --json", async () => {
    const r = await cli(["recording", "propose", takeA, takeB, "--json"]);
    expect(dataOf(r.out).params.map((p) => p.name).sort()).toEqual(["account", "reply", "thread"]);
  });

  test("reports the untied subject line as an ambiguity in --json", async () => {
    const r = await cli(["recording", "propose", takeA, takeB, "--json"]);
    expect(dataOf(r.out).ambiguities).toContainEqual(expect.objectContaining({ kind: "untied-observation", stepIds: ["s-subj"] }));
  });

  test("shows the ambiguities prominently in the human output", async () => {
    const r = await cli(["recording", "propose", takeA, takeB]);
    expect(r.out).toMatch(/AMBIGUITIES \(\d+\)[^\n]*\n\s+! \[untied-observation\] steps: s-subj/);
  });

  test("warns that the draft replays every step when no stop step was found", async () => {
    const r = await cli(["recording", "propose", noSendA, noSendB]);
    expect(r.out).toMatch(/WARNING: no stop step/);
  });

  test("refuses a single take as a usage error", async () => {
    expect((await cli(["recording", "propose", takeA, "--json"])).exitCode).toBe(64);
  });

  test("names too few takes in the refusal code", async () => {
    const r = await cli(["recording", "propose", takeA, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_PROPOSAL_TOO_FEW_TAKES" } });
  });

  test("saves the draft in the journeys store unpromoted", async () => {
    const r = await cli(["recording", "propose", takeA, takeB, "--json"]);
    expect((await savedDraft(r.journeysDir))?.metadata.promoted).toBe(false);
  });

  test("saves a draft that ends before the Send step", async () => {
    const r = await cli(["recording", "propose", takeA, takeB, "--json"]);
    const ids = ((await savedDraft(r.journeysDir))?.recording.pages ?? []).flatMap((p) => p.steps.map((s) => s.stepId));
    expect(ids).not.toContain("s-send");
  });

  test("never replaces an existing Journey with a draft", async () => {
    const first = await cli(["recording", "propose", takeA, takeB, "--json"]);
    const again = await cli(["recording", "propose", takeA, takeB, "--json"], first.journeysDir);
    expect(JSON.parse(again.out)).toMatchObject({ ok: false, error: { code: "E_PROPOSAL_DRAFT_EXISTS" } });
  });

  test("--out writes the draft to the file instead of the journeys store", async () => {
    const out = join(root, "draft-out.json");
    const r = await cli(["recording", "propose", takeA, takeB, "--out", out, "--json"]);
    expect([(JSON.parse(await readFile(out, "utf8")) as Journey).metadata.id, await savedDraft(r.journeysDir)]).toEqual(["proposed-draft", null]);
  });

  test("--no-draft saves nothing", async () => {
    const r = await cli(["recording", "propose", takeA, takeB, "--no-draft", "--json"]);
    expect(await savedDraft(r.journeysDir)).toBeNull();
  });

  test("never puts the password in any output or the saved draft", async () => {
    const human = await cli(["recording", "propose", takeA, takeB]);
    const json = await cli(["recording", "propose", takeA, takeB, "--json"]);
    const file = await readFile(dataOf(json.out).draft!.path, "utf8");
    expect([human.out, json.out, file].some((t) => t.includes(PASSWORD))).toBe(false);
  });
});

// === MCP ===

function mcp(): { tool: (n: string) => McpTool; journeysDir: string } {
  const journeysDir = freshJourneysDir();
  const tools = new Map(
    buildMcpTools({
      journeysDir,
      pathRoots: [root],
      runCli: makeInProcessCliRunner(() => buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir })),
    }).map((t) => [t.name, t]),
  );
  return { tool: (n) => tools.get(n)!, journeysDir };
}

const textOf = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join("");

describe("the MCP recordings tool", () => {
  test("propose returns the proposed parameters", async () => {
    const res = await mcp().tool("recordings").handler({ action: "propose", take: takeA, more: [takeB] });
    const data = (JSON.parse(textOf(res)) as { data: ProposeData }).data;
    expect(data.params.map((p) => p.name).sort()).toEqual(["account", "reply", "thread"]);
  });

  test("propose saves the draft unpromoted in the server's journeys store", async () => {
    const m = mcp();
    await m.tool("recordings").handler({ action: "propose", take: takeA, more: [takeB], id: "reply-draft" });
    expect((await savedDraft(m.journeysDir, "reply-draft"))?.metadata.promoted).toBe(false);
  });

  test("propose returns no typed reply text and no password", async () => {
    const text = textOf(await mcp().tool("recordings").handler({ action: "propose", take: takeA, more: [takeB] }));
    expect([REPLY_A, REPLY_B, PASSWORD].some((v) => text.includes(v))).toBe(false);
  });

  test("propose refuses a take path outside the server's roots", async () => {
    const res = await mcp().tool("recordings").handler({ action: "propose", take: "/etc/hosts", more: [takeB] });
    expect(JSON.parse(textOf(res))).toMatchObject({ error: "invalid_args", message: expect.stringMatching(/resolves outside/) });
  });

  test("diff returns no captured value anywhere in its result", async () => {
    const text = textOf(await mcp().tool("recordings").handler({ action: "diff", takeA, takeB }));
    expect([REPLY_A, REPLY_B, USERNAME, PASSWORD, "acct-support", "acct-billing"].filter((v) => text.includes(v))).toEqual([]);
  });

  test("postdoc returns a constant's value redacted", async () => {
    const decisions = join(root, "decisions.json");
    await writeFile(decisions, JSON.stringify([{ step: { page: 0, step: 0 }, classify: "constant" }]));
    const text = textOf(await mcp().tool("recordings").handler({ action: "postdoc", take: takeA, more: [takeB], decisions }));
    expect(text.includes(USERNAME)).toBe(false);
  });
});
