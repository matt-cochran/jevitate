import { describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";

/**
 * #744: `explore-author-journey`'s own argument errors name the argument at fault and print a
 * corrected invocation — exit 64, under the command's own `E_EXPLORE_AUTHOR_JOURNEY_ARGS` (the code
 * commander's parse errors already use). A literal secret in the invocation is never echoed back.
 */

const URL = "http://127.0.0.1:3000/settings";
const COMPLETE = ["--url", URL, "--goal", "Save the form", "--success", "urlIncludes:/saved", "--id", "save", "--name", "Save", "--fake-ai", "--json"];

function capture(): { program: ReturnType<typeof buildProgram>; lines: string[] } {
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused-in-these-tests") });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  return { program, lines };
}

async function run(argv: readonly string[]): Promise<{ code: string | undefined; message: string; exit: number | undefined }> {
  const { program, lines } = capture();
  process.exitCode = undefined;
  await program.parseAsync(["explore-author-journey", ...argv], { from: "user" });
  const exit = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  const env = JSON.parse(lines.join("")) as { ok: boolean; error?: { code: string; message: string } };
  return { code: env.error?.code, message: env.error?.message ?? "", exit };
}

/** The complete invocation with one required flag dropped (and its value, when it has one). */
function without(flag: string): string[] {
  const at = COMPLETE.indexOf(flag);
  return [...COMPLETE.slice(0, at), ...COMPLETE.slice(at + 2)];
}

describe("explore-author-journey argument guidance (#744)", () => {
  it("a missing required flag carries the command's own usage code", async () => {
    expect((await run(without("--name"))).code).toBe("E_EXPLORE_AUTHOR_JOURNEY_ARGS");
  });

  it("a missing required flag exits 64", async () => {
    expect((await run(without("--name"))).exit).toBe(64);
  });

  it("a missing required flag is named in the refusal", async () => {
    expect((await run(without("--name"))).message).toContain("--name");
  });

  it("a missing required flag refusal prints a corrected invocation of the command", async () => {
    expect((await run(without("--name"))).message).toContain("jevitate explore-author-journey");
  });

  it("the corrected invocation keeps the arguments already given", async () => {
    expect((await run(without("--name"))).message).toContain("--id save");
  });

  it("a nonexistent --storage-state is named in the refusal", async () => {
    expect((await run([...COMPLETE, "--storage-state", "/nonexistent/storage-state.json"])).message).toContain("--storage-state");
  });

  it("a nonexistent --storage-state carries the command's own usage code", async () => {
    expect((await run([...COMPLETE, "--storage-state", "/nonexistent/storage-state.json"])).code).toBe("E_EXPLORE_AUTHOR_JOURNEY_ARGS");
  });

  it("a literal --secret value is never echoed in the corrected invocation", async () => {
    expect((await run([...without("--name"), "--secret", "s3cr3t-value"])).message).not.toContain("s3cr3t-value");
  });
});
