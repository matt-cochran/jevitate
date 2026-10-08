import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import type { SweepResult } from "./sweep-api.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #425 end to end through `jevitate sweep`, on a served fixture and a real Chromium: three tiny
 * targets at concurrency 2 — two pages call the same failing API (one defect, two sightings), one
 * is clean and runs as a persona — then `--resume` re-runs nothing, and re-runs exactly the target
 * whose finished run was removed.
 */

const hits: Record<string, number> = {};
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/a" || path === "/b" || path === "/c") {
      const api = path === "/c" ? "/api/ok" : "/api/broken";
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body><h1>${path}</h1><button type="button">Go</button><script>fetch("${api}")</script></body></html>`);
      return;
    }
    if (path === "/api/broken") {
      res.writeHead(500, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/api/ok") {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function sweep(argv: string[]): Promise<{ env: { ok: boolean; data: SweepResult }; code: number | undefined }> {
  const lines: string[] = [];
  const p = buildProgram({
    profiles: {} as unknown as ProfileManager,
    explore: {
      judge: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
      gen: new FakeGenerationGateway(),
      browserPortFactory: () => new PlaywrightBrowserPort(),
    },
  });
  p.exitOverride();
  p.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  process.exitCode = undefined;
  await p.parseAsync(["sweep", ...argv, "--json"], { from: "user" });
  const code = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = 0;
  return { env: JSON.parse(lines.join("")) as { ok: boolean; data: SweepResult }, code };
}

describe("jevitate sweep (#425)", () => {
  it(
    "runs 3 targets at concurrency 2, dedupes the shared defect across targets, then --resume re-runs only what is missing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-sweep-"));
      try {
        await writeFile(join(dir, "viewer.json"), JSON.stringify({ cookies: [], origins: [] }));
        const targets = join(dir, "targets.json");
        await writeFile(
          targets,
          JSON.stringify({
            baseUrl: origin,
            defaults: { strategy: "adversarial", tags: { release: "0.8.0" }, options: { maxDecisions: 1, minControlCoverage: 0, requireFormSubmit: false } },
            targets: [
              { id: "page-a", route: "/a", tags: { feature: "a" } },
              { id: "page-b", route: "/b", tags: { feature: "b" } },
              { id: "page-c", route: "/c", persona: "viewer.json", tags: { feature: "c" } },
            ],
          }),
        );
        const out = join(dir, "out");
        const { env, code } = await sweep(["--targets", targets, "--concurrency", "2", "--out", out, "--tag", "suite=nightly"]);
        expect(env.ok, JSON.stringify(env)).toBe(true);
        const r = env.data;
        expect(r).toMatchObject({ kind: "sweep", complete: true, concurrency: 2, summary: { targets: 3, ran: 3, resumed: 0, errors: 0 } });
        expect(r.targets.map((t) => [t.id, t.status])).toEqual([
          ["page-a", "ran"],
          ["page-b", "ran"],
          ["page-c", "ran"],
        ]);
        expect(r.targets.map((t) => t.missionOutcome)).toEqual(["defects-found", "defects-found", "clean"]);
        expect(r.missionOutcome).toBe("defects-found");
        expect(code).toBe(1);
        // One defect (the same endpoint + status), two sightings.
        const broken = r.defects.filter((d) => d.kind === "http-5xx");
        expect(broken).toHaveLength(1);
        expect(broken[0]).toMatchObject({ sightingCount: 2, targets: ["page-a", "page-b"] });
        // #426: every run is tagged (sweep + target + target=<id>); the persona is the run's target.persona.
        const c = JSON.parse(await readFile(join(out, "page-c", "run.envelope.json"), "utf8")) as { data: { tags: unknown; target: { persona?: string } } };
        expect(c.data.tags).toEqual({ suite: "nightly", release: "0.8.0", feature: "c", target: "page-c" });
        expect(c.data.target.persona).toBe("viewer");
        expect(r.targets[2]).toMatchObject({ persona: "viewer", tags: { suite: "nightly", release: "0.8.0", feature: "c", target: "page-c" } });
        const onDisk = JSON.parse(await readFile(join(out, "sweep.result.json"), "utf8")) as SweepResult;
        expect(onDisk.defects).toEqual(r.defects);

        // --resume: everything finished — nothing re-runs, the aggregate is the same.
        const before = { ...hits };
        const resumed = (await sweep(["--targets", targets, "--concurrency", "2", "--out", out, "--resume"])).env.data;
        expect(hits).toEqual(before);
        expect(resumed.summary).toMatchObject({ ran: 0, resumed: 3 });
        expect(resumed.defects.find((d) => d.kind === "http-5xx")).toMatchObject({ sightingCount: 2 });

        // Remove one finished run: --resume re-runs exactly that target.
        await unlink(join(out, "page-b", "run.envelope.json"));
        const again = (await sweep(["--targets", targets, "--out", out, "--resume"])).env.data;
        expect(again.targets.map((t) => t.status)).toEqual(["resumed", "ran", "resumed"]);
        expect(hits["/b"]).toBeGreaterThan(before["/b"] ?? 0);
        expect(hits["/a"]).toBe(before["/a"]);
      } finally {
        process.exitCode = 0;
        await rm(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
