import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { ProfileManager } from "@jevitate/daemon";
import type { BrowserPort } from "@jevitate/playwright";
import { buildProgram, type CliDeps } from "../program.js";

/** #519: --scope-region refusals are E_EXPLORE_ARGS (exit 64) and name their reason, before any browser opens. */

let journeys: string;
let opened = 0;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "jev-519-cli-"));
  journeys = join(dir, "journeys");
  mkdirSync(journeys, { recursive: true });
  writeFileSync(
    join(journeys, "wiz.json"),
    JSON.stringify({
      metadata: { id: "wiz", name: "wiz", promoted: true, params: [], createdAtIso: "2026-10-15T00:00:00Z", anchors: [{ name: "wizard", step: 1, stepId: "s-click1", region: "testId=import-view" }] },
      recording: { version: "1", site: "https://shop.test", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { testId: "go" }, expect: { kind: "visible", target: { testId: "ok" } } }, stepId: "s-click1" }] }] },
    }),
  );
});

async function explore(argv: readonly string[]): Promise<{ code: number; envelope: { error?: { code: string; message: string } } }> {
  const refusingPort = { launch: async () => { opened++; throw new Error("a browser opened"); } } as unknown as BrowserPort;
  const deps = { profiles: new ProfileManager(join(tmpdir(), "jev-519-profiles")), explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => refusingPort } } as unknown as CliDeps;
  const out: string[] = [];
  const program = buildProgram(deps);
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  process.exitCode = undefined;
  await program.parseAsync(["explore", ...argv, "--json"], { from: "user" });
  return { code: Number(process.exitCode), envelope: JSON.parse(out.join("").trim().split("\n")[0]!) };
}

describe("explore --scope-region refusals (#519)", () => {
  it("refuses --scope-region beside an anchor's region with E_EXPLORE_ARGS", async () => {
    const r = await explore(["--from-journey", "wiz", "--at-step", "wizard", "--journeys-dir", journeys, "--strategy", "adversarial", "--fake-ai", "--scope-region", "testId=x"]);
    expect(r.envelope.error?.code).toBe("E_EXPLORE_ARGS");
  });

  it("names the anchor and its region", async () => {
    const r = await explore(["--from-journey", "wiz", "--at-step", "wizard", "--journeys-dir", journeys, "--strategy", "adversarial", "--fake-ai", "--scope-region", "testId=x"]);
    expect(r.envelope.error?.message).toMatch(/anchor wizard declares the scope region testId=import-view/);
  });

  it("exits 64 for a goal run", async () => {
    expect((await explore(["--url", "http://127.0.0.1:3999/", "--goal", "g", "--success", "urlIncludes:/x", "--fake-ai", "--scope-region", "testId=x"])).code).toBe(64);
  });

  it("opens no browser for any refusal", () => {
    expect(opened).toBe(0);
  });
});
