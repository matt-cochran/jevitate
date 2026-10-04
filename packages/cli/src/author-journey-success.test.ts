import { describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * #322: `explore-author-journey --success` takes every kind `explore --success` takes but
 * reloadThen — a requestMade-only job reaches the browser instead of exiting 64. The port is a
 * capturing fake that aborts before any browser starts.
 */
function capture(): { program: ReturnType<typeof buildProgram>; lines: string[]; opens: OpenOptions[] } {
  const opens: OpenOptions[] = [];
  const port: BrowserPort = {
    async open(opts) {
      opens.push(opts);
      throw new Error("open intercepted by test");
    },
  };
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => port },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, opens };
}

const URL = "http://127.0.0.1:3000/settings";
const base = ["explore-author-journey", "--url", URL, "--goal", "Save the form", "--id", "save", "--name", "Save", "--fake-ai", "--json"];

async function run(success: string[]): Promise<{ code: string | undefined; opens: number }> {
  const { program, lines, opens } = capture();
  process.exitCode = undefined;
  await program.parseAsync([...base, ...success.flatMap((s) => ["--success", s])], { from: "user" });
  process.exitCode = undefined;
  const env = JSON.parse(lines.join("")) as { ok: boolean; error?: { code: string } };
  return { code: env.error?.code, opens: opens.length };
}

describe("explore-author-journey --success (#322)", () => {
  it("accepts a requestMade-only job (it reaches the browser, no E_EXPLORE_ASSERTION)", async () => {
    const r = await run(["requestMade:POST /api.v1.Settings/Save"]);
    expect(r.code).not.toBe("E_EXPLORE_ASSERTION");
    expect(r.opens).toBe(1);
  });

  it("accepts several checks of mixed kinds", async () => {
    const r = await run(["visible:text=Saved", "responseStatus:POST /api.v1.Settings/Save=2xx"]);
    expect(r.code).not.toBe("E_EXPLORE_ASSERTION");
    expect(r.opens).toBe(1);
  });

  it("refuses reloadThen (and a bad spec) before any browser", async () => {
    expect(await run(["reloadThen:visible:text=Saved"])).toEqual({ code: "E_EXPLORE_ASSERTION", opens: 0 });
    expect(await run(["nonsense:x"])).toEqual({ code: "E_EXPLORE_ASSERTION", opens: 0 });
  });
});
