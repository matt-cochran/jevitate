import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { clock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { OutcomeWait } from "@jevitate/recording";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { advisoryCatalogDir } from "./done-check-policy.testkit.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits — the 2-minute job below takes ~2 min of PAGE time only.
useSkippingTime({ per: "all" });

/**
 * #409 — a per-step outcome wait for a long-running job. "Generate" POSTs a job; the page shows a
 * role=status "Generating variations…" while it runs and, two minutes (page time) later, renders
 * three previews. A Journey's waited `expect` on that click polls until the previews are there, and
 * the run result records the actual wait. Under `verify --mutate`, the skipped (or blocked) job step
 * fails its waited claim once it has waited past what the base replay took, never after the whole
 * `maxMs`. Its progress signal cannot end that wait: the action that brings the signal may be what was
 * mutated, and a wait cut short would read a job an earlier step started as sensitivity.
 */

const JOB_MS = 120_000;
/** The first test's loose bound on what a replay of the job reads under skipping time. */
const BASE_READS_AT_MOST_MS = JOB_MS + 60_000;
/** The base, the independence replay, the two mutations, one control and the closing replay. */
const ALL_REPLAYS = 6;

const html = `<!doctype html><html><head><title>Designs</title></head><body><main>
  <h1>Designs</h1>
  <button type="button" id="gen">Generate</button>
  <div id="out"></div>
  <script>
    document.getElementById("gen").addEventListener("click", async () => {
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      status.textContent = "Generating variations…";
      document.body.appendChild(status);
      try {
        const r = await fetch("/api/generate", { method: "POST" });
        if (!r.ok) throw new Error("refused");
        setTimeout(() => {
          for (let i = 1; i <= 3; i++) {
            const p = document.createElement("figure");
            p.setAttribute("data-testid", "variation-preview");
            p.textContent = "Variation " + i;
            document.getElementById("out").appendChild(p);
          }
          status.remove();
        }, ${JOB_MS});
      } catch {
        status.remove();
      }
    });
  </script>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/generate") {
      res.writeHead(202, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-wait-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const previews = { kind: "count" as const, target: { testId: "variation-preview" }, min: 3 };
const progress = { kind: "visible" as const, target: { css: "[role=status]" } };

function journey(id: string, waitFor: OutcomeWait): Journey {
  return {
    metadata: { id, name: "Generate variations", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/designs",
          steps: [
            { step: { kind: "navigate", url: "/designs", expect: { kind: "visible", target: { role: "heading", name: "Designs" } } } },
            {
              step: { kind: "click", target: { role: "button", name: "Generate" }, expect: previews, waitFor },
              delta: { verdict: "relevant-change", why: "job started", changes: ["status"], requests: ["POST /api/generate → 202"], overheadMs: 1 },
            },
          ],
        },
      ],
    },
  };
}

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    catalogDir: advisoryCatalogDir(dir),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), exitCode };
}

async function stored(j: Journey): Promise<string> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  return journeysDir;
}

interface Wait {
  step: number;
  waitedMs: number;
  maxMs: number;
  ending: string;
}

describe("#409 waitFor — a per-step outcome wait for a long-running job (served)", () => {
  it("passes once the 2-minute job shows ≥3 previews, and the result records the ~2 min wait", async () => {
    const j = journey("generate", { maxMs: 240_000, until: "held", progress });
    const r = await cli(await stored(j), ["journey", "run", "generate", "--json"]);
    const data = (JSON.parse(r.out) as { data: { outcome: string; reason?: string; waits?: Wait[] } }).data;
    expect(data.reason).toBeUndefined();
    expect(data.outcome).toBe("ok");
    expect(data.waits).toHaveLength(1);
    expect(data.waits![0]).toMatchObject({ step: 2, ending: "held", maxMs: 240_000 });
    expect(data.waits![0]!.waitedMs).toBeGreaterThanOrEqual(JOB_MS - 2_000);
    // ~2 min: under skipping time the page clock may trail Node's on a loaded host (a skip's page
    // `runFor` is raced against 1.5 s), so the upper bound is loose — far below the 4 min maxMs.
    expect(data.waits![0]!.waitedMs).toBeLessThan(JOB_MS + 60_000);
    expect(r.exitCode).toBe(0);
  }, 240_000);

  it("a progress signal that stalls ends the wait as a hang that names the signal, long before maxMs", async () => {
    const stalled = { kind: "textIncludes" as const, target: { css: "[role=status]" }, text: "Step 99 of 99" };
    const j = journey("generate-stalled", { maxMs: 240_000, progress: stalled, stallMs: 5_000 });
    const r = await cli(await stored(j), ["journey", "run", "generate-stalled", "--json"]);
    const data = (JSON.parse(r.out) as { data: { outcome: string; reason?: string; waits?: Wait[] } }).data;
    expect(data.outcome).toBe("quarantined");
    expect(data.reason).toMatch(/hang: the progress signal \(.*\) was absent and unchanged for [0-9.]+s \(stallMs 5000\)/);
    expect(data.waits![0]).toMatchObject({ step: 2, ending: "hang", maxMs: 240_000 });
    expect(data.waits![0]!.waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(data.waits![0]!.waitedMs).toBeLessThan(JOB_MS);
  }, 240_000);

  it("verify --mutate: skip and block-write of the job step make the waited claim fail past the base replay's time (sensitive), not after maxMs", async () => {
    const j = journey("generate-proof", { maxMs: 1_200_000, progress });
    const started = clock.monotonicMs();
    const r = await cli(await stored(j), ["journey", "verify", "generate-proof", "--mutate", "--json"]);
    const elapsed = clock.monotonicMs() - started;
    const report = (JSON.parse(r.out) as {
      data: { base: { outcome: string }; verdict: string; mutations: { id: string; outcome: string; reason?: string }[]; assertions: { site: string; verdict: string; provedBy?: string }[] };
    }).data;
    expect(report.base.outcome).toBe("ok");
    expect(report.mutations.map((m) => `${m.id}=${m.outcome}`)).toEqual(["skip:2=failed", "block-write:2=failed"]);
    for (const m of report.mutations) {
      // This replay's bound and the Journey's own, both: the proof sets the first.
      const wait = /step 2 failed: .*postcondition failed: kind=count .* — waited [0-9.]+s \(this replay's waitFor maxMs ([0-9]+); the Journey's is 1200000\); it never held/.exec(m.reason ?? "");
      expect(wait, m.reason).not.toBeNull();
      // Past the base's 2 minutes by a quarter and a second; the base can read long here, as the page clock trails Node's under skipping time.
      expect(Number(wait![1])).toBeGreaterThan(JOB_MS);
      expect(Number(wait![1])).toBeLessThan(BASE_READS_AT_MOST_MS * 1.25 + 1_000);
    }
    expect(report.assertions.find((a) => a.site === "step:2")).toEqual(expect.objectContaining({ verdict: "sensitive", provedBy: "skip:2" }));
    expect(report.verdict).toBe("proven");
    expect(r.exitCode).toBe(0);
    // The base, independence, closing and any control replays wait out the 2-minute job, and each mutation a little past it: never the 20 min of `maxMs`, each.
    expect(elapsed).toBeLessThan(ALL_REPLAYS * BASE_READS_AT_MOST_MS * 1.25);
    expect(elapsed).toBeLessThan(1_200_000);
  }, 480_000);
});
