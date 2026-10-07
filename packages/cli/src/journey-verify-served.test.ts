import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Assertion, RecordedStep } from "@jevitate/recording";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #402 — `journey verify --mutate`: a Journey's assertions are evidence only if they FAIL when the
 * outcome is absent. A small app: a Save that POSTs the typed text and a status line that shows the
 * saved text (kept server-side per browser session, so every replay starts from nothing saved).
 */

const sessions = new Map<string, string>();
let nextSid = 0;

function page(saved: string | undefined): string {
  return `<!doctype html><html><head><title>Editor</title></head><body><main>
  <h1>Editor</h1>
  <label for="t">Text</label> <input id="t">
  <button type="button" id="save">Save</button>
  <p data-testid="status">${saved === undefined ? "Nothing saved" : `Saved: ${saved}`}</p>
  <script>
    document.getElementById("save").addEventListener("click", async () => {
      const text = document.getElementById("t").value;
      try {
        const r = await fetch("/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
        if (r.ok) document.querySelector("[data-testid=status]").textContent = "Saved: " + text;
      } catch { /* aborted */ }
    });
  </script>
</main></body></html>`;
}

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const sid = /sid=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
    if (req.method === "POST" && req.url === "/api/save") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        if (sid !== undefined) sessions.set(sid, (JSON.parse(body) as { text: string }).text);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    const id = sid ?? String((nextSid += 1));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(sid === undefined ? { "set-cookie": `sid=${id}; Path=/` } : {}) }).end(page(sessions.get(id)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const textField = { label: "Text" };
const saveButton = { role: "button" as const, name: "Save" };
const saveDelta = { verdict: "relevant-change" as const, why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 };

function journey(id: string, opts: { fillExpect: Assertion; save: Partial<RecordedStep> & { step: RecordedStep["step"] }; endState?: Journey["metadata"]["endState"] }): Journey {
  return {
    metadata: { id, name: "Save text", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00.000Z", ...(opts.endState === undefined ? {} : { endState: opts.endState }) },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/editor",
          steps: [
            { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
            { step: { kind: "fill", target: textField, value: { redacted: false, value: "hello" }, expect: opts.fillExpect } },
            { delta: saveDelta, ...opts.save },
          ],
        },
      ],
    },
  };
}

/** As authored by a recorder that only knew "the thing I touched is there". */
const weak = (id: string): Journey =>
  journey(id, {
    fillExpect: { kind: "visible", target: textField },
    save: { step: { kind: "click", target: saveButton, expect: { kind: "visible", target: saveButton } } },
  });

/** Strengthened: the field's value, the save's own response, and the saved text after a reload. */
const strong = (id: string): Journey =>
  journey(id, {
    fillExpect: { kind: "valueEquals", target: textField, value: "hello" },
    save: {
      step: { kind: "click", target: saveButton, expect: { kind: "count", target: { testId: "status" }, min: 0 } },
      expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } }],
    },
    endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Saved: hello" } }],
  });

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

interface Report {
  journeyId: string;
  journeyHash: string;
  base: { outcome: string };
  verdict: string;
  mutations: { kind: string; step: number; id: string; outcome: string; failedSites: unknown[]; blockedWrites?: string[] }[];
  assertions: { site: string; verdict: string; provedBy?: string; check: string }[];
  summary: Record<string, number>;
}

async function verify(j: Journey, extra: string[] = []): Promise<{ exitCode: number | undefined; report: Report; out: string }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const r = await cli(journeysDir, ["journey", "verify", j.metadata.id, "--mutate", ...extra]);
  if (extra.includes("--json")) return { exitCode: r.exitCode, report: (JSON.parse(r.out) as { data: Report }).data, out: r.out };
  return { exitCode: r.exitCode, report: undefined as unknown as Report, out: r.out };
}

const verdictOf = (r: Report, site: string): { verdict: string; provedBy?: string } | undefined => {
  const a = r.assertions.find((x) => x.site === site);
  return a === undefined ? undefined : { verdict: a.verdict, ...(a.provedBy === undefined ? {} : { provedBy: a.provedBy }) };
};

describe("journey verify --mutate (#402, served)", () => {
  it("a weak Journey: the save step's own-target-visible expect still passes when the save is skipped or blocked — insensitive, exit 1", async () => {
    const { exitCode, report } = await verify(weak("weak"), ["--json"]);
    expect(report.base.outcome).toBe("ok");
    expect(report.mutations.map((m) => `${m.id}=${m.outcome}`)).toEqual(["skip:3=passed", "block-write:3=passed"]);
    expect(report.mutations.find((m) => m.id === "block-write:3")?.blockedWrites).toEqual(["POST /api/save"]);
    expect(verdictOf(report, "step:3")).toEqual({ verdict: "insensitive" });
    expect(verdictOf(report, "step:1")).toEqual({ verdict: "unpaired" });
    expect(report.verdict).toBe("insensitive");
    expect(report.journeyHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(exitCode).toBe(1);
  }, 180_000);

  it("a strengthened Journey: the step-request status and the reloadThen are sensitive under skip and block-write; the valueEquals under stale-value — exit 0", async () => {
    const { exitCode, report } = await verify(strong("strong"), ["--json"]);
    expect(report.base.outcome).toBe("ok");
    expect(report.mutations.map((m) => `${m.id}=${m.outcome}`)).toEqual(["skip:3=failed", "block-write:3=failed", "stale-value:2=failed"]);
    expect(verdictOf(report, "step-request:3:0")).toEqual({ verdict: "sensitive", provedBy: "skip:3" });
    expect(verdictOf(report, "end-state:0")).toEqual({ verdict: "sensitive", provedBy: "skip:3" });
    expect(verdictOf(report, "step:2")).toEqual({ verdict: "sensitive", provedBy: "stale-value:2" });
    // block-write alone proves the request and the persisted text too.
    const blocked = report.mutations.find((m) => m.id === "block-write:3")!;
    expect(blocked.failedSites).toEqual(expect.arrayContaining([{ where: "step-request", step: 3, checkIndex: 0 }, { where: "end-state", index: 0 }]));
    expect(report.verdict).toBe("proven");
    expect(exitCode).toBe(0);
  }, 240_000);

  it("block-write that did not block the step's own recorded write is not-applied, never a proof", async () => {
    const j = weak("not-applied");
    j.recording.pages[0]!.steps[2]!.delta = { ...saveDelta, requests: ["POST /api/other → 200"] };
    const { report } = await verify(j, ["--json"]);
    const m = report.mutations.find((x) => x.id === "block-write:3")!;
    expect(m.outcome).toBe("not-applied");
    expect(m.reason).toMatch(/own write was not blocked/);
  }, 180_000);

  it("human output: one line per assertion, then a summary", async () => {
    const { exitCode, out } = await verify(weak("weak-human"));
    expect(out).toMatch(/^insensitive\s+step:3\s+/m);
    expect(out).toMatch(/^unpaired\s+step:1\s+/m);
    expect(exitCode).toBe(1);
  }, 180_000);

  it("a Journey whose unmutated replay fails is inconclusive (exit 2) and no mutation runs", async () => {
    const broken = weak("broken");
    broken.recording.pages[0]!.steps[0]!.step = { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Nope" } } };
    const { exitCode, report } = await verify(broken, ["--json"]);
    expect(report.base.outcome).toBe("quarantined");
    expect(report.mutations).toEqual([]);
    expect(report.verdict).toBe("inconclusive");
    expect(exitCode).toBe(2);
  }, 180_000);

  it("without --mutate the command refuses (a usage error), nothing runs", async () => {
    const journeysDir = join(dir, "refuse");
    await new FsJourneyStore(journeysDir).put(weak("refuse"));
    const r = await cli(journeysDir, ["journey", "verify", "refuse", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.out).toMatch(/E_JOURNEY_VERIFY_ARGS/);
    expect(r.out).toMatch(/--mutate/);
  });
});
