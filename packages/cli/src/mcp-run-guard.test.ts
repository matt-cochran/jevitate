import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real browser: the default new PlaywrightBrowserPort() behind run_journey (test/browser-suites.ts reads this).
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import type { Journey } from "@jevitate/journey";
import type { RecordedStep } from "@jevitate/recording";
import { buildMcpTools } from "./mcp-api.js";
import { CLI_TOOL_SPECS } from "./mcp-cli-tools.js";
import { journeyReviewHash } from "./journey-review.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { loadTargetsFile, TargetConfigError } from "./target-config.js";
import { confineMcpPath, McpPathError } from "./mcp-paths.js";
import { homeDataRoot } from "./project-dir.js";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { allowedOriginSet, offAllowlistWriteOrigin, prepareMcpRunGuard } from "./mcp-run-guard.js";
import { canonicalOrigin, resolveTargetConfig } from "./target-config.js";

/** #789: an MCP-driven replay refuses destructive clicks and off-allowlist writes before anything leaves the browser. */

let app: Server;
let other: Server;
let appOrigin: string;
let otherOrigin: string;
let root: string;
let journeysDir: string;
let targetsFile: string;
const hits = { delete: 0, other: 0, redirected: 0, frames: 0, otherPaths: [] as string[] };

const html = (body: string): string => `<!doctype html><meta charset=utf-8><title>t</title>${body}`;

function send(res: import("node:http").ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
  res.end(html(body));
}

function journey(id: string, steps: RecordedStep[], parameters: Journey["metadata"]["parameters"] = []): Journey {
  const j = {
    metadata: { id, name: id, promoted: true, params: [], parameters, createdAtIso: "2026-11-05T00:00:00.000Z" },
    recording: { version: "1", site: appOrigin, pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "ready" } } } }, ...steps] }] },
  } as unknown as Journey;
  j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" };
  return j;
}

const click = (testId: string, expectId: string): RecordedStep => ({ step: { kind: "click", target: { testId }, expect: { kind: "visible", target: { testId: expectId } } } }) as RecordedStep;

function seed(j: Journey): void {
  writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
}

async function run(id: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<{ isError?: boolean; body: Record<string, unknown>; text: string }> {
  const tool = buildMcpTools({
    journeysDir,
    pathRoots: [root],
    targetsConfigPath: targetsFile,
    selfHealGateways: async () => {
      const { FakeGenerationGateway, FakeJudgmentGateway, UsageTracker } = await import("@jevitate/ai-core");
      return { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), usage: new UsageTracker() };
    },
  }).find((t) => t.name === "run_journey")!;
  const res = await tool.handler({ id, params, ...extra });
  const text = res.content[0]!.text;
  return { ...(res.isError === undefined ? {} : { isError: res.isError }), body: JSON.parse(text) as Record<string, unknown>, text };
}

const configure = (mcpRun: object, more: object = {}): void => writeFileSync(targetsFile, JSON.stringify({ [appOrigin]: { mcpRun, ...more } }));

beforeAll(async () => {
  other = createServer((req, res) => {
    if (req.method === "POST") {
      hits.other += 1;
      hits.otherPaths.push(req.url ?? "");
    }
    send(res, "<h1 data-testid=done>other origin</h1>");
  });
  // A minimal WebSocket endpoint: completes the handshake and counts what the page sent.
  other.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", () => void (hits.frames += 1));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  otherOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
  app = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/delete") {
      hits.delete += 1;
      send(res, "<p data-testid=gone>deleted</p>");
      return;
    }
    if (req.method === "POST" && req.url === "/save") {
      send(res, "<p data-testid=saved>saved</p>");
      return;
    }
    if (req.method === "POST" && req.url === "/redirect") {
      res.writeHead(307, { location: `${otherOrigin}/after-redirect` });
      res.end();
      return;
    }
    if (req.url === "/rows") {
      send(res, `<i data-testid=ready>ready</i><main class=rows><ul>
        <li><button data-testid=row-del onclick="fetch('/delete',{method:'POST'})">Delete account</button><button data-testid=row-open>Open panel</button></li>
      </ul></main>`);
      return;
    }
    if (req.url === "/fetch-off") {
      send(res, `<i data-testid=ready>ready</i><button data-testid=go onclick="fetch('${otherOrigin}/beacon',{method:'POST',body:'x'}).catch(()=>0);document.body.insertAdjacentHTML('beforeend','<p data-testid=clicked>clicked</p>')">Save</button>`);
      return;
    }
    send(
      res,
      `<i data-testid=ready>ready</i>
      <form method=post action=/delete><button data-testid=del>Delete account</button></form>
      <form method=post action=/delete><button data-testid=wrapped><span data-testid=inner>Delete</span> account</button></form>
      <input data-testid=before-del aria-label="Before"><form method=post action=/delete><button data-testid=focus-del>Delete it</button></form>
      <form method=post action="${otherOrigin}/ext"><button data-testid=ext>Export</button></form>
      <form method=post action=/redirect><button data-testid=redir>Continue</button></form>
      <button data-testid=noop onclick="document.body.insertAdjacentHTML('beforeend','<p data-testid=clicked>clicked</p>')">Open panel</button>
      <form method=post action=/delete><input data-testid=enter-del-field aria-label="Type the name"><button>Delete account</button></form>
      <form method=post action=/delete><input data-testid=enter-first-field aria-label="First field"><button type=button>Help</button><button>Delete it</button><button>Keep it</button></form>
      <form method=post action=/delete id=assoc><input data-testid=enter-assoc-field aria-label="Assoc field"></form><button form=assoc>Delete everything</button>
      <form method=post action=/delete><input type=checkbox data-testid=enter-check-field aria-label="Sure"><button>Delete now</button></form>
      <form method=post action=/save><input data-testid=enter-plain-field aria-label="Plain field"><button>Save</button></form>
      <form method=post action=/delete><input data-testid=enter-disabled-field aria-label="Other"><input aria-label="Second"><button disabled>Delete disabled</button></form>
      <form method=post action=/delete><textarea data-testid=enter-area-field aria-label="Notes"></textarea><button>Delete notes</button></form>
      <button data-testid=ws-send onclick="const s=new WebSocket('ws://127.0.0.1:${(other.address() as { port: number }).port}/feed');s.onopen=()=>{s.send('frame');document.body.insertAdjacentHTML('beforeend','<p data-testid=ws-sent>sent</p>')}">Send update</button>
      <input data-testid=tenant aria-label="Tenant">
      <button data-testid=named onclick="document.title=1">Delete customer-xyz</button>
      <a href="/fetch-off" data-testid=fetch-link>fetch page</a>`,
    );
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  appOrigin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-789-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  targetsFile = join(root, "targets.json");
});

afterAll(() => {
  for (const s of [app, other]) {
    s.closeAllConnections();
    s.close();
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  hits.delete = 0;
  hits.other = 0;
  hits.redirected = 0;
  hits.frames = 0;
  hits.otherPaths.length = 0;
  rmSync(targetsFile, { force: true });
});

describe("#789 destructive controls over MCP", () => {
  it("refuses 'Delete account' by default: nothing reaches the server; the outcome is typed and names the setting", async () => {
    seed(journey("del", [click("del", "gone")]));
    const r = await run("del");
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: "refused", outcome: "refused", code: "E_RUN_REFUSED_DESTRUCTIVE", rule: "builtin:destructive", at: 2, retryable: false, setting: `targets.json["${appOrigin}"].mcpRun.allowDestructive` });
    expect(hits.delete).toBe(0);
  });

  describe("in a forEach row", () => {
    const rows = (id: string, testId: string): Journey =>
      journey(id, [{ step: { kind: "forEach", items: { css: "main.rows li" }, as: "row", steps: [{ kind: "click", target: { testId }, expect: { kind: "count", target: { testId }, min: 0 } }] } } as RecordedStep], []);
    const atRows = (j: Journey): Journey => {
      const again = structuredClone(j);
      again.recording.pages[0]!.url = "/rows";
      (again.recording.pages[0]!.steps[0]!.step as { url: string }).url = "/rows";
      again.metadata.approval = { contentHash: journeyReviewHash({ ...again, metadata: { ...again.metadata, approval: undefined } } as Journey), at: "2026-11-05T00:00:00.000Z" };
      return again;
    };

    it("refuses a row's destructive click, as a plain step's: nothing reaches the server", async () => {
      seed(atRows(rows("rows-del", "row-del")));
      const r = await run("rows-del");
      expect(r.body).toMatchObject({ error: "refused", outcome: "refused", code: "E_RUN_REFUSED_DESTRUCTIVE", rule: "builtin:destructive", at: 2, retryable: false });
      expect(hits.delete).toBe(0);
    });

    it("judges the row's control by what it is called, not the step that holds it", async () => {
      seed(atRows(rows("rows-open", "row-open")));
      const r = await run("rows-open");
      expect(r.body).toMatchObject({ outcome: "ok" });
      expect(hits.delete).toBe(0);
    });

    it("a person's mcpRun.allowDestructive lets it through", async () => {
      seed(atRows(rows("rows-del-ok", "row-del")));
      configure({ allowDestructive: true });
      await run("rows-del-ok");
      expect(hits.delete).toBeGreaterThan(0);
    });
  });

  it("a person's mcpRun.allowDestructive lets it through, on that target only", async () => {
    seed(journey("del-ok", [click("del", "gone")]));
    configure({ allowDestructive: true });
    const r = await run("del-ok");
    expect(r.body.outcome, r.text).toBe("ok");
    expect(hits.delete).toBe(1);
    writeFileSync(targetsFile, JSON.stringify({ "http://other.example.test": { mcpRun: { allowDestructive: true } } }));
    expect((await run("del-ok")).body.code).toBe("E_RUN_REFUSED_DESTRUCTIVE");
    expect(hits.delete).toBe(1);
  });

  it("exploration's safety.allowDestructive is not the switch", async () => {
    seed(journey("del-safety", [click("del", "gone")]));
    writeFileSync(targetsFile, JSON.stringify({ [appOrigin]: { safety: { allowDestructive: true } } }));
    expect((await run("del-safety")).body.code).toBe("E_RUN_REFUSED_DESTRUCTIVE");
    expect(hits.delete).toBe(0);
  });

  it("judges the live element: a click on an inner span of a named button, recorded by test id", async () => {
    seed(journey("del-span", [click("inner", "gone")]));
    expect((await run("del-span")).body.code).toBe("E_RUN_REFUSED_DESTRUCTIVE");
    expect(hits.delete).toBe(0);
  });

  it("refuses Enter on a focused destructive button", async () => {
    const focus = { step: { kind: "click", target: { testId: "before-del" }, expect: { kind: "visible", target: { testId: "before-del" } } } } as RecordedStep;
    const tab = { step: { kind: "press", key: "Tab", expect: { kind: "visible", target: { testId: "before-del" } } } } as RecordedStep;
    const enter = { step: { kind: "press", key: "Enter", expect: { kind: "visible", target: { testId: "gone" } } } } as RecordedStep;
    seed(journey("del-enter", [focus, tab, enter]));
    const r = await run("del-enter");
    expect(r.body.code, r.text).toBe("E_RUN_REFUSED_DESTRUCTIVE");
    expect(hits.delete).toBe(0);
  });

  describe("Enter in a field submits its form through the form's default button", () => {
    const focusThenEnter = (field: string, done: string): RecordedStep[] => [
      { step: { kind: "click", target: { testId: field }, expect: { kind: "visible", target: { testId: field } } } } as RecordedStep,
      { step: { kind: "press", key: "Enter", expect: { kind: "visible", target: { testId: done } } } } as RecordedStep,
    ];

    it("refuses by default: the POST never reaches the server, and the refusal is the destructive one", async () => {
      seed(journey("enter-del", focusThenEnter("enter-del-field", "gone")));
      const r = await run("enter-del");
      expect(r.body, r.text).toMatchObject({ error: "refused", code: "E_RUN_REFUSED_DESTRUCTIVE", at: 3, setting: `targets.json["${appOrigin}"].mcpRun.allowDestructive` });
      expect(hits.delete).toBe(0);
    });

    it("reaches the server once a person sets mcpRun.allowDestructive", async () => {
      seed(journey("enter-del-ok", focusThenEnter("enter-del-field", "gone")));
      configure({ allowDestructive: true });
      const r = await run("enter-del-ok");
      expect(r.body.outcome, r.text).toBe("ok");
      expect(hits.delete).toBe(1);
    });

    it("the default button is the form's first submit button in tree order, an associated one outside the form too", async () => {
      seed(journey("enter-del-second", focusThenEnter("enter-first-field", "gone")));
      expect((await run("enter-del-second")).body.code).toBe("E_RUN_REFUSED_DESTRUCTIVE");
      seed(journey("enter-del-assoc", focusThenEnter("enter-assoc-field", "gone")));
      expect((await run("enter-del-assoc")).body.code).toBe("E_RUN_REFUSED_DESTRUCTIVE");
      expect(hits.delete).toBe(0);
    });

    it("a field that is no text box submits the same way", async () => {
      seed(journey("enter-del-check", focusThenEnter("enter-check-field", "gone")));
      expect((await run("enter-del-check")).body.code).toBe("E_RUN_REFUSED_DESTRUCTIVE");
      expect(hits.delete).toBe(0);
    });

    it("what Enter does not submit is not refused: a harmless default button, a disabled one, a textarea, Space in the field", async () => {
      seed(journey("enter-plain", focusThenEnter("enter-plain-field", "saved")));
      const plain = await run("enter-plain");
      expect(plain.body.outcome, plain.text).toBe("ok");
      seed(journey("enter-disabled", focusThenEnter("enter-disabled-field", "enter-disabled-field")));
      const disabled = await run("enter-disabled");
      expect(disabled.body.outcome, disabled.text).toBe("ok");
      seed(journey("enter-area", focusThenEnter("enter-area-field", "enter-area-field")));
      const area = await run("enter-area");
      expect(area.body.outcome, area.text).toBe("ok");
      seed(journey("space-field", [focusThenEnter("enter-del-field", "enter-del-field")[0]!, { step: { kind: "press", key: "Space", expect: { kind: "visible", target: { testId: "enter-del-field" } } } } as RecordedStep]));
      const space = await run("space-field");
      expect(space.body.outcome, space.text).toBe("ok");
      expect(hits.delete).toBe(0);
    });
  });

  it("the target's own safety.deny holds even with allowDestructive", async () => {
    seed(journey("deny", [click("noop", "clicked")]));
    configure({ allowDestructive: true }, { safety: { deny: ["/^Open panel$/"] } });
    const r = await run("deny");
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_DESTRUCTIVE", setting: `targets.json["${appOrigin}"].safety.deny` });
  });

  it("a refusal carries no page text and no parameter value", async () => {
    const fill = { step: { kind: "fill", target: { testId: "tenant" }, value: { var: "customer" }, expect: { kind: "visible", target: { testId: "tenant" } } } } as RecordedStep;
    seed(journey("del-named", [fill, click("named", "gone")], [{ name: "customer", description: "who", secret: true }]));
    const r = await run("del-named", { customer: "customer-xyz" });
    expect(r.body.code, r.text).toBe("E_RUN_REFUSED_DESTRUCTIVE");
    expect(r.text).not.toContain("customer-xyz");
  });

  it("an ordinary click is not refused", async () => {
    seed(journey("plain", [click("noop", "clicked")]));
    const r = await run("plain");
    expect(r.body.outcome, r.text).toBe("ok");
  });
});

describe("#789 off-allowlist writes over MCP", () => {
  it("a form post to another origin never leaves the browser by default", async () => {
    seed(journey("off", [click("ext", "done")]));
    const r = await run("off");
    expect(r.body).toMatchObject({ error: "refused", code: "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE", at: 2, retryable: false, setting: `targets.json["${appOrigin}"].mcpRun.allowOffAllowlistWrites` });
    expect(String(r.body.message)).toContain(otherOrigin);
    expect(hits.other).toBe(0);
  });

  it("a fetch the page swallows still ends the run: a refused write is never read as a pass", async () => {
    seed(journey("off-fetch", [click("fetch-link", "go"), click("go", "clicked")]));
    const r = await run("off-fetch");
    expect(r.body.code, r.text).toBe("E_RUN_REFUSED_OFF_ALLOWLIST_WRITE");
    expect(hits.other).toBe(0);
  });

  describe("WebSocket frames", () => {
    // A self-heal run routes the context's sockets too, and the last route added is the one Playwright calls.
    const heal = { selfHeal: "hybrid", fakeAi: true, changeNote: ["renamed Send to Send update"] };
    const steps = [click("ws-send", "ws-sent"), click("noop", "clicked")];

    it("a frame to another origin never leaves the browser, and ends the run", async () => {
      seed(journey("ws-off", steps));
      const r = await run("ws-off");
      expect(r.body.code, r.text).toBe("E_RUN_REFUSED_OFF_ALLOWLIST_WRITE");
      expect(hits.frames).toBe(0);
    });

    it("the same under a self-heal run", async () => {
      seed(journey("ws-off-heal", steps));
      const r = await run("ws-off-heal", {}, heal);
      expect(r.body.code, r.text).toBe("E_RUN_REFUSED_OFF_ALLOWLIST_WRITE");
      expect(hits.frames).toBe(0);
    });

    it("a self-heal run lets the frame through once a person lists that origin", async () => {
      seed(journey("ws-ok-heal", steps));
      configure({ allowOffAllowlistWrites: [otherOrigin] });
      // A self-heal run writes its result under the project: this one's, never the real home's.
      mkdirSync(join(root, ".jevitate"), { recursive: true });
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      try {
        const r = await run("ws-ok-heal", {}, heal);
        expect(r.body.outcome, r.text).toBe("ok");
        await vi.waitFor(() => expect(hits.frames).toBeGreaterThan(0), { timeout: 5_000 });
      } finally {
        cwd.mockRestore();
      }
    });
  });

  it("reaches the server once a person lists that origin", async () => {
    seed(journey("off-ok", [click("ext", "done")]));
    configure({ allowOffAllowlistWrites: [otherOrigin] });
    const r = await run("off-ok");
    expect(r.body.outcome, r.text).toBe("ok");
    expect(hits.other).toBe(1);
    expect(r.body.offAllowlistWrites).toEqual([otherOrigin]);
  });

  it("a redirected write is detected, and ends the run the same way, saying it may have been sent", async () => {
    seed(journey("off-redirect", [click("redir", "done")]));
    const r = await run("off-redirect");
    expect(r.body.code, r.text).toBe("E_RUN_REFUSED_OFF_ALLOWLIST_WRITE");
    expect(String(r.body.message)).toContain("may have been sent");
  });

  it("outside an MCP invocation `journey run` is unchanged: the write is sent and reported", async () => {
    seed(journey("cli-off", [click("ext", "done")]));
    const r = await runJourneyProgrammatically({ dir: journeysDir, id: "cli-off", params: {} });
    expect(r.outcome).toBe("ok");
    expect(hits.other).toBe(1);
    expect(r.offAllowlistWrites).toEqual([otherOrigin]);
    seed(journey("cli-del", [click("del", "gone")]));
    expect((await runJourneyProgrammatically({ dir: journeysDir, id: "cli-del", params: {} })).outcome).toBe("ok");
    expect(hits.delete).toBe(1);
  });
});

describe("#789 production", () => {
  const seedEnvironments = (): string => {
    const dir = join(root, "project", ".jevitate");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "environments.json");
    writeFileSync(path, JSON.stringify({ live: { baseUrl: appOrigin, production: true } }));
    return path;
  };

  it("refuses an environment flagged production: true, before any browser, unless a person allows it", async () => {
    const environmentsFile = seedEnvironments();
    seed(journey("prod", [click("noop", "clicked")]));
    const tool = () => buildMcpTools({ journeysDir, pathRoots: [root], targetsConfigPath: targetsFile, environmentsFile }).find((t) => t.name === "run_journey")!;
    const refused = JSON.parse((await tool().handler({ id: "prod", env: "live" })).content[0]!.text) as Record<string, unknown>;
    expect(refused).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION", setting: `targets.json["${appOrigin}"].mcpRun.allowProduction`, retryable: false });
    configure({ allowProduction: true });
    const allowed = JSON.parse((await tool().handler({ id: "prod", env: "live" })).content[0]!.text) as Record<string, unknown>;
    expect(allowed.outcome).toBe("ok");
  });
});

describe("#789 only a person's targets.json can lift a refusal", () => {
  // `allowDestructive` as an argument exists on exploration tools (`--allow-destructive`, exploration's
  // own policy): it never reaches this guard, which reads only `mcpRun` from the targets file.
  const LIFTING = /mcpRun|allowOffAllowlist|allowProduction/i;
  const tools = (): ReturnType<typeof buildMcpTools> => buildMcpTools({ journeysDir, pathRoots: [root] });

  it("the served tools still equal ALLOWED_TOOLS: no tool was added", () => {
    expect(tools().map((t) => t.name).sort()).toEqual([...ALLOWED_TOOLS].sort());
  });

  it("no served tool takes an argument that could set it, in any schema", () => {
    const names = (schema: unknown): string[] => {
      if (schema === null || typeof schema !== "object") return [];
      const o = schema as Record<string, unknown>;
      return [...Object.keys((o.properties ?? {}) as object), ...Object.values(o).flatMap((v) => names(v))];
    };
    for (const t of tools()) expect(names(t.inputSchema).filter((n) => LIFTING.test(n)), t.name).toEqual([]);
    for (const spec of CLI_TOOL_SPECS) expect(LIFTING.test(JSON.stringify(spec)), spec.name).toBe(false);
  });

  it("no path argument may name the file: refused read or written, through a symlink or not", () => {
    const home = homeDataRoot();
    expect(() => confineMcpPath(join(home, "targets.json"), "out", [home])).toThrow(McpPathError);
    expect(() => confineMcpPath(join(home, "targets.json"), "saveStorageState", [home], { session: true })).toThrow(McpPathError);
    expect(() => confineMcpPath(join(home, "sub", "..", "targets.json"), "out", [home])).toThrow(McpPathError);
  });

  it("mission_targets and site_policy refuse the field: unknown argument, and the file is untouched", async () => {
    for (const name of ["mission_targets", "site_policy"]) {
      const tool = tools().find((t) => t.name === name)!;
      const res = await tool.handler({ action: "add", mcpRun: { allowDestructive: true } });
      expect(res.isError, name).toBe(true);
      expect(res.content[0]!.text).toContain("invalid_args");
    }
  });

  it("targets.json is parsed strictly: an unknown key, a wrong type or a non-origin refuses the file", () => {
    const load = (mcpRun: unknown): unknown => {
      writeFileSync(targetsFile, JSON.stringify({ "https://a.test": { mcpRun } }));
      return loadTargetsFile(targetsFile)["https://a.test"]?.mcpRun;
    };
    expect(load({ allowDestructive: true, allowOffAllowlistWrites: ["https://b.test"], allowProduction: false })).toEqual({ allowDestructive: true, allowOffAllowlistWrites: ["https://b.test"], allowProduction: false });
    for (const bad of [true, { allowEverything: true }, { allowDestructive: "yes" }, { allowOffAllowlistWrites: ["*"] }, { allowOffAllowlistWrites: ["https://b.test/path"] }, { allowOffAllowlistWrites: "https://b.test" }]) {
      expect(() => load(bad), JSON.stringify(bad)).toThrow(TargetConfigError);
    }
  });

  it("a targets file it cannot read refuses the run (fail closed), with no browser", async () => {
    seed(journey("bad-config", [click("noop", "clicked")]));
    writeFileSync(targetsFile, "{ not json");
    const r = await run("bad-config");
    expect(r.body).toMatchObject({ error: "refused", code: "E_RUN_GUARD_CONFIG", retryable: false });
  });
});

describe("an alias of a flagged origin", () => {
  const prepared = (site: string, environments: object, targets: object = {}): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "jev-guard-alias-"));
    const environmentsFile = join(dir, "environments.json");
    const file = join(dir, "targets.json");
    writeFileSync(environmentsFile, JSON.stringify(environments));
    writeFileSync(file, JSON.stringify(targets));
    return runAsMcpInvocation(async () => {
      try {
        prepareMcpRunGuard({ site, allowedOrigins: [site], environmentsFile, targetsFile: file });
        return "allowed";
      } catch (err) {
        return (err as { code: string }).code;
      }
    });
  };
  const FLAGGED = { prod: { baseUrl: "https://app.example.com", production: true } };

  it.each(["https://app.example.com", "https://APP.example.com:443", "https://app.example.com.", "https://app.example.com..", "https://App.Example.COM.:443/x"])("%s is refused as the flagged origin", async (site) => {
    expect(await prepared(site, FLAGGED)).toBe("E_RUN_REFUSED_PRODUCTION");
  });

  it("the flag and the targets entry may themselves be written as an alias", async () => {
    expect(await prepared("https://app.example.com", { prod: { baseUrl: "https://APP.example.com.", production: true } })).toBe("E_RUN_REFUSED_PRODUCTION");
    expect(await prepared("https://app.example.com.", FLAGGED, { "https://APP.example.com:443/": { mcpRun: { allowProduction: true } } })).toBe("allowed");
  });

  it("a different scheme or an IP can't be known as the same site: docs/safety.md says so", async () => {
    expect(await prepared("http://app.example.com", FLAGGED)).toBe("allowed");
    expect(await prepared("https://192.0.2.1", FLAGGED)).toBe("allowed");
  });

  it("the allowlist reads a write to an alias as the same origin, and any other as off it", () => {
    const allowed = allowedOriginSet(["https://app.example.com"]);
    expect(offAllowlistWriteOrigin("POST", "https://APP.example.com.:443/save", allowed)).toBeUndefined();
    expect(offAllowlistWriteOrigin("POST", "https://other.example.com/save", allowed)).toBe("https://other.example.com");
    expect(canonicalOrigin("not a url")).toBeUndefined();
  });

  it("a target's safety.deny reaches an alias", () => {
    const file = { "https://app.example.com": { safety: { deny: ["Wire transfer"] } } };
    expect(resolveTargetConfig(file, "https://app.example.com.").safety?.deny).toEqual(["Wire transfer"]);
    expect(resolveTargetConfig({ "https://APP.example.com/": { safety: { deny: ["x"] } } }, "https://app.example.com").safety?.deny).toEqual(["x"]);
    expect(resolveTargetConfig(file, "https://other.example.com").safety?.deny).toBeUndefined();
  });
});

describe("the operator's own files under ~/.jevitate", () => {
  const home = homeDataRoot();
  it.each(["targets.json", "TARGETS.JSON", "Targets.Json", "./x/../targets.json", "verify-checkpoint.key", "VERIFY-CHECKPOINT.KEY"])("%s is refused to a path argument", (name) => {
    expect(() => confineMcpPath(join(home, name), "file", [home])).toThrow(McpPathError);
  });

  it("is refused through a linked home, on the real path", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-paths-"));
    mkdirSync(home, { recursive: true });
    const link = join(dir, "home-link");
    symlinkSync(home, link);
    expect(() => confineMcpPath(join(link, "targets.json"), "file", [dir, home])).toThrow(McpPathError);
    expect(() => confineMcpPath(join(link, "verify-checkpoint.key"), "file", [dir, home])).toThrow(McpPathError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("another file there is still allowed", () => {
    expect(confineMcpPath(join(home, "other.json"), "file", [home])).toBe(join(home, "other.json"));
  });
});
