import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, isOwnTargetVisible } from "@jevitate/journey";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { GOAL_ALREADY_MET_QUESTION, GOAL_MET_QUESTION } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * #400 served e2e: an authored Journey carries the outcome evidence. The goal's `--success` checks
 * (a write's status and a `reloadThen` persistence check) become its end state; the publish click's
 * own expect is the write it sent (`responseStatus … PublishSiteEdits=2xx`), never "the Publish
 * button is visible". The Journey replays green, and fails once publishing stops persisting.
 */

const RPC = "/portal.v1.OwnerSiteEditService/PublishSiteEdits";
let state = "draft";
let persist = true;
const app = (): string => `<!doctype html><html><head><title>Site editor</title></head><body><main>
  <h1>Site editor</h1>
  <p data-testid="live">Site is ${state}</p>
  <button type="button" id="publish">Publish</button>
  <p role="status" id="status"></p>
  <script>
    document.getElementById("publish").onclick = () =>
      fetch(${JSON.stringify(RPC)}, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(() => {
        document.getElementById("status").textContent = "Your site is live";
      });
  </script></main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "POST" && path === RPC) {
      if (persist) state = "published";
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(app());
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-author-outcome-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Clicks Publish, then done. */
function publishJudge(): JudgmentPort {
  let clicked = false;
  return {
    async systemOne({ questions }: { questions: Record<string, { kind: string; options?: string[]; descriptions?: Record<string, string> }> }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const pick = clicked ? "done" : (q.options ?? []).find((id) => /click .*Publish/.test(q.descriptions?.[id] ?? ""));
          if (pick !== undefined && !clicked) clicked = true;
          out[key] = { kind: "choice", value: pick ?? "wait", confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) out[key] = { kind: "noul", value: true, probability: 0.95 };
        else if (key === GOAL_ALREADY_MET_QUESTION) out[key] = { kind: "noul", value: false, probability: 0.05 };
        else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options?.[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  } as unknown as JudgmentPort;
}

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { judge: publishJudge(), gen: new FakeGenerationGateway(), browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir, "no-targets.json") },
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

describe("explore-author-journey keeps the outcome evidence — served (#400)", () => {
  useSkippingTime();

  it("end state = the --success checks; the publish step expects its write; the Journey fails when publishing stops persisting", async () => {
    const journeysDir = join(dir, "journeys");
    const r = await cli(journeysDir, [
      "explore-author-journey", "--url", `${origin}/`, "--goal", "Publish the site",
      "--success", `responseStatus:POST ${RPC}=2xx`,
      "--success", "reloadThen:textIncludes:testId=live|published",
      "--id", "publish", "--name", "Publish", "--fake-ai", "--max-decisions", "6", "--action-deltas",
      "--out", join(dir, "runs"), "--json",
    ]);
    expect((JSON.parse(r.out) as { data: { outcome: string } }).data.outcome, r.out).toBe("authored");

    const journey = await new FsJourneyStore(journeysDir).get("publish");
    if (journey === null) throw new Error("no Journey saved");
    expect(journey.metadata.endState).toEqual([
      { kind: "responseStatus", method: "POST", pathGlob: RPC, status: { class: 2 } },
      { kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } },
    ]);
    const steps = journey.recording.pages.flatMap((p) => p.steps);
    const publish = steps.find((s) => s.step.kind === "click");
    expect(publish?.expectRequests).toEqual([{ kind: "responseStatus", method: "POST", pathGlob: RPC, status: { class: 2 } }]);
    for (const s of steps) expect(isOwnTargetVisible(s.step), JSON.stringify(s.step)).toBe(false);

    await cli(journeysDir, ["journey", "promote", "publish", "--json"]);
    state = "draft";
    const ok = await cli(journeysDir, ["journey", "run", "publish", "--json"]);
    expect((JSON.parse(ok.out) as { data: { outcome: string } }).data.outcome, ok.out).toBe("ok");

    // Publishing still answers 200 but no longer persists: the end state's reloadThen catches it.
    state = "draft";
    persist = false;
    const broken = await cli(journeysDir, ["journey", "run", "publish", "--json"]);
    const data = (JSON.parse(broken.out) as { data: { outcome: string; reason?: string } }).data;
    expect(data.outcome).toBe("quarantined");
    expect(data.reason).toMatch(/reloadThen:textIncludes:testId=live\|published/);
    persist = true;
  }, 180_000);
});
