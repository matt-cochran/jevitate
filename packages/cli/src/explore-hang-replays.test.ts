import { describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * #275: `--hang-replays <n>` is parsed to a number by commander (`nonNegativeIntArg`); a later
 * re-validation called `.trim()` on it and crashed every run before any JSON envelope. The flag
 * must be accepted (0 included, #154) and reach the run; a bad value is a usage error.
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
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, opens };
}

const URL = "http://127.0.0.1:3000/app";

describe("explore --hang-replays (#275)", () => {
  for (const [strategy, extra] of [
    ["goal", ["--goal", "g", "--success", "urlIncludes:/x"]],
    ["adversarial", []],
  ] as const) {
    for (const n of ["0", "3"]) {
      it(`${strategy}: --hang-replays ${n} is accepted and the run starts (no TypeError)`, async () => {
        const { program, lines, opens } = capture();
        await program.parseAsync(["explore", "--strategy", strategy, "--url", URL, ...extra, "--hang-replays", n, "--json"], {
          from: "user",
        });
        expect(lines.join("")).not.toMatch(/trim is not a function/);
        expect(opens).toHaveLength(1);
      });
    }
  }

  it("a non-integer value is refused as a usage error before any browser opens", async () => {
    const { program, opens } = capture();
    await expect(
      program.parseAsync(["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--hang-replays", "x", "--json"], {
        from: "user",
      }),
    ).rejects.toThrow();
    expect(opens).toHaveLength(0);
  });
});
