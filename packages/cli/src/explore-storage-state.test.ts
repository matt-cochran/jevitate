import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * `--storage-state <file>` is the deterministic authenticated pre-step for exploring an app
 * behind a login (found dogfooding against a real app: explore could only start logged out).
 * It must reach `BrowserPort.open` for EVERY mission the flag is offered on, fail fast when the
 * file is missing, and be absent when the flag is not given. The port is a capturing fake that
 * aborts before any browser starts.
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
    explore: {
      judge: new FakeJudgmentGateway({}),
      gen: new FakeGenerationGateway(),
      browserPortFactory: () => port,
    },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, opens };
}

const URL = "http://127.0.0.1:3000/app";

function withStateFile(fn: (path: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-state-"));
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
    try {
      await fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("--storage-state reaches BrowserPort.open", () => {
  const cases: { name: string; argv: string[] }[] = [
    { name: "explore (goal)", argv: ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x"] },
    { name: "explore --strategy coverage", argv: ["explore", "--strategy", "coverage", "--url", URL] },
    { name: "explore --strategy adversarial", argv: ["explore", "--strategy", "adversarial", "--url", URL] },
    {
      name: "explore --strategy usability",
      argv: ["explore", "--strategy", "usability", "--url", URL, "--goal", "g", "--app-class", "admin"],
    },
    {
      name: "explore-author-journey",
      argv: ["explore-author-journey", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--id", "j", "--name", "J"],
    },
  ];

  for (const c of cases) {
    it(
      `${c.name}: the session is seeded from the storage state`,
      withStateFile(async (state) => {
        const { program, opens } = capture();
        await program.parseAsync([...c.argv, "--storage-state", state, "--json"], { from: "user" });
        expect(opens).toHaveLength(1);
        expect(opens[0]!.storageState).toBe(state);
      }),
    );
  }

  it("fails fast (no browser opened) when the storage state file does not exist", async () => {
    const { program, lines, opens } = capture();
    await program.parseAsync(
      ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--storage-state", "/nope/state.json", "--json"],
      { from: "user" },
    );
    expect(opens).toHaveLength(0);
    const out = JSON.parse(lines.join(""));
    expect(out).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
    expect(out.error.message).toContain("storage state not found");
  });

  it("without the flag the session carries no storage state", async () => {
    const { program, opens } = capture();
    await program.parseAsync(["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x", "--json"], {
      from: "user",
    });
    expect(opens).toHaveLength(1);
    expect("storageState" in opens[0]!).toBe(false);
  });
});
