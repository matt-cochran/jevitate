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
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits — the 2-minute job below takes ~2 min of PAGE time only.
useSkippingTime({ per: "all" });

/**
 * #409 — a per-step outcome wait for a long-running job. "Generate" POSTs a job; the page shows a
 * role=status "Generating variations…" while it runs and, two minutes (page time) later, renders
 * three previews. A Journey's waited `expect` on that click polls until the previews are there, and
 * the run result records the actual wait. Under `verify --mutate`, the skipped (or blocked) job step
 * fails its waited claim at the hang threshold, never after the whole `maxMs`.
 */

const JOB_MS = 120_000;

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

  it("verify --mutate: skip and block-write of the job step make the waited claim fail at the hang threshold (sensitive), not after maxMs", async () => {
    const j = journey("generate-proof", { maxMs: 1_200_000, progress });
    const started = clock.monotonicMs();
    const r = await cli(await stored(j), ["journey", "verify", "generate-proof", "--mutate", "--json"]);
    const elapsed = clock.monotonicMs() - started;
    const report = (JSON.parse(r.out) as {
      data: { base: { outcome: string }; verdict: string; mutations: { id: string; outcome: string; reason?: string }[]; assertions: { site: string; verdict: string; provedBy?: string }[] };
    }).data;
    expect(report.base.outcome).toBe("ok");
    expect(report.mutations.map((m) => `${m.id}=${m.outcome}`)).toEqual(["skip:2=failed", "block-write:2=failed"]);
    for (const m of report.mutations) expect(m.reason).toMatch(/step 2 failed: .*postcondition failed: kind=count .* — hang: the progress signal \(kind=visible target=\{"css":"\[role=status\]"\}\)/);
    expect(report.assertions.find((a) => a.site === "step:2")).toEqual(expect.objectContaining({ verdict: "sensitive", provedBy: "skip:2" }));
    expect(report.verdict).toBe("proven");
    expect(r.exitCode).toBe(0);
    // The base replay waits out the 2-minute job; each mutation at most the 30 s hang threshold — never 20 min.
    expect(elapsed).toBeLessThan(JOB_MS + 2 * 30_000 + 120_000);
  }, 300_000);
});
