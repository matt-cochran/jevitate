import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { runJourneyProgrammatically } from "./journey-api.js";
import { verifyCheckpointPath } from "./journey-verify-checkpoint.js";
import { verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";

/**
 * A control a pair skipped only because another pair errored must not be missing from what a resume
 * reads. A toast from an earlier step (800 ms) has nothing to do with the fill, and `stale-value` is
 * the only mutation paired with it: the truth is `insensitive`. With `skip:2` errored, `stale-value:4`
 * finds the proof can no longer be `proven` and skips its control. A resume repairs `skip:2`, and
 * reusing that pair as it stood read `step:5` sensitive and the proof `proven`.
 *
 * [realtime]: a page timer the replays have to outlast, whose decay is the whole point.
 */
const PAGE = `<!doctype html><title>t</title><main><h1>App</h1>
<button id=start onclick="fetch('/start',{method:'POST'}).then(()=>{document.getElementById('st').textContent='Started'})">Start</button><p id=st></p>
<input id=note aria-label=Note>
<button id=flash onclick="const t=document.getElementById('toast');t.textContent='hello';setTimeout(()=>{t.textContent=''},800)">Flash</button><p id=toast></p></main>`;

describe("[realtime] a skipped control and a resume", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.method === "POST" ? "ok" : PAGE);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const journey = (id: string): unknown => ({
    metadata: { id, name: id, promoted: false, params: [], createdAtIso: "2026-11-05T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "App" } } } },
            { step: { kind: "click", target: { role: "button", name: "Start" }, expect: { kind: "visible", target: { text: "Started" } } }, delta: { verdict: "relevant-change", why: "s", changes: ["s"], requests: ["POST /start → 200"], overheadMs: 1 } },
            { step: { kind: "click", target: { role: "button", name: "Flash" }, expect: { kind: "count", target: { css: "#toast" }, min: 0 } } },
            { step: { kind: "fill", target: { label: "Note" }, value: { redacted: false, value: "hello" }, expect: { kind: "count", target: { label: "Note" }, min: 0 } } },
            { step: { kind: "assert", check: { kind: "textIncludes", target: { css: "#toast" }, text: "hello" } } },
            { step: { kind: "assert", check: { kind: "visible", target: { role: "heading", name: "App" } } } },
          ],
        },
      ],
    },
  });

  const setup = (id: string): { dir: string; checkpoint: (resume: boolean) => never; path: string } => {
    const root = mkdtempSync(join(tmpdir(), "jev-resume-control-"));
    const dir = join(root, "journeys");
    mkdirSync(dir);
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(journey(id)));
    const path = verifyCheckpointPath(join(root, ".jevitate"), dir, id);
    const checkpoint = (resume: boolean): never => ({ path, keyFile: join(root, "k.key"), resume, build: { version: "t", commit: "c", builtAt: "b", tree: "tr" }, config: { hook: {}, origin: {}, browser: {} } }) as never;
    return { dir, checkpoint, path };
  };

  const prove = (dir: string, id: string, extra: Record<string, unknown> = {}, run: typeof runJourneyProgrammatically = runJourneyProgrammatically): Promise<JourneyVerifyReport> =>
    verifyJourneyMutations({ dir, id, params: {}, browserPortFactory: () => new PlaywrightBrowserPort(), ...extra } as never, run);

  const verdictAt = (r: JourneyVerifyReport, site: string): string | undefined => r.assertions.find((a) => a.site === site)?.verdict;

  it("reads what the uninterrupted proof reads: the toast's decay is not sensitivity", async () => {
    const plain = setup("plain");
    const truth = await prove(plain.dir, "plain");
    expect(truth.verdict).toBe("insensitive");
    expect(verdictAt(truth, "step:5")).toBe("insensitive");

    const { dir, checkpoint, path } = setup("resumed");
    let current = "";
    const crashing = ((options: never, mutation: never) => {
      if (current.startsWith("skip:2")) throw new Error("Target page, context or browser has been closed");
      return runJourneyProgrammatically(options, mutation);
    }) as typeof runJourneyProgrammatically;
    const first = await prove(dir, "resumed", { checkpoint: checkpoint(false), onProgress: (p: { mutation?: string }) => void (current = p.mutation ?? "") }, crashing);
    expect(first.verdict).toBe("inconclusive");
    expect(first.mutations.find((m) => m.id === "stale-value:4")?.controlSkipped).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { body: { errorGap?: boolean } }).body.errorGap).toBe(true);

    const second = await prove(dir, "resumed", { checkpoint: checkpoint(true) });
    expect(second.verdict).toBe("insensitive");
    expect(verdictAt(second, "step:5")).toBe("insensitive");
    const stale = second.mutations.find((m) => m.id === "stale-value:4");
    expect(stale?.reused).toBeUndefined();
    expect(stale?.controlSkipped).toBeUndefined();
    expect(stale?.control).toBe("failed");
    expect(second.mutations.find((m) => m.id === "block-write:2")?.reused).toBe(true);
    expect(second.reusedPairs).toBe(1);
  }, 240_000);
});
