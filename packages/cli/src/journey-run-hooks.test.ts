import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import { runJourneyProgrammatically } from "./journey-api.js";
import { RunHeldError, RunHookError, registerRunHooks, resetRunHooksForTests, runBeforeWriteHooks, withRunHookGuard, type RunHookContext } from "./journey-run-hooks.js";

/** 0.30.0: run hooks registered by other modules run in registration order; one that throws fails the run with E_RUN_HOOK. */

const HOOKS = fileURLToPath(new URL("./journey-run-hooks.ts", import.meta.url));

let root: string;
let journeysDir: string;

/** Hooks a module registers when it is imported; each records into the shared `calls` it is given. */
function moduleSource(owner: string, opts: { readonly throwIn?: string } = {}): string {
  return `import { registerRunHooks } from ${JSON.stringify(pathToFileURL(HOOKS).href)};
const calls = globalThis.__runHookCalls;
registerRunHooks(${JSON.stringify(owner)}, {
  resolveMode: () => { calls.push(${JSON.stringify(`${owner}.resolveMode`)}); return undefined; },
  validateParams: () => {
    calls.push(${JSON.stringify(`${owner}.validateParams`)});
    ${opts.throwIn === "validateParams" ? `throw new Error("no such customer");` : ""}
  },
});
`;
}

async function importModule(name: string, source: string): Promise<void> {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, source);
  await import(pathToFileURL(file).href);
}

const calls: string[] = [];

beforeAll(() => {
  (globalThis as { __runHookCalls?: string[] }).__runHookCalls = calls;
  root = mkdtempSync(join(tmpdir(), "jev-run-hooks-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  const j = {
    metadata: { id: "hooked", name: "hooked", promoted: true, params: [], createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: { version: "1", site: "http://127.0.0.1:9", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "x" } } } }] }] },
  } as unknown as Journey;
  writeFileSync(join(journeysDir, "hooked.json"), JSON.stringify(j));
});

afterEach(() => {
  resetRunHooksForTests();
  calls.length = 0;
});

afterAll(() => {
  delete (globalThis as { __runHookCalls?: string[] }).__runHookCalls;
  rmSync(root, { recursive: true, force: true });
});

/** A run no browser is ever opened for: every hook here runs before one would be. */
const run = () =>
  runJourneyProgrammatically({
    dir: journeysDir,
    id: "hooked",
    params: {},
    browserPortFactory: () => {
      throw new Error("no browser in this test");
    },
  });

describe("run hooks", () => {
  it("two modules' hooks run in registration order, at each point", async () => {
    await importModule("first", moduleSource("first"));
    await importModule("second", moduleSource("second", { throwIn: "validateParams" }));
    await run().catch(() => undefined);
    expect(calls).toEqual(["first.resolveMode", "second.resolveMode", "first.validateParams", "second.validateParams"]);
  });

  it("a hook that throws fails the run with E_RUN_HOOK, naming its owner and point", async () => {
    await importModule("third", moduleSource("third", { throwIn: "validateParams" }));
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RunHookError);
    expect(err).toMatchObject({ code: "E_RUN_HOOK", owner: "third", point: "validateParams", retryable: false });
    expect(String((err as Error).message)).toContain("third.validateParams");
  });

  it("the first mode a hook answers wins; an unregistered hook is not called", async () => {
    const seen: string[] = [];
    const off = registerRunHooks("a", { resolveMode: () => void seen.push("a") });
    registerRunHooks("b", {
      resolveMode: () => "test",
      validateParams: (ctx) => {
        seen.push(`mode:${ctx.mode}`);
        throw new Error("stop here");
      },
    });
    registerRunHooks("c", { resolveMode: () => "automation" });
    off();
    await expect(run()).rejects.toMatchObject({ code: "E_RUN_HOOK", owner: "b" });
    expect(seen).toEqual(["mode:test"]);
  });

  it("a beforeWrite hold tells every onHold hook, then ends the run held at that step", async () => {
    const seen: string[] = [];
    registerRunHooks("watch", { beforeWrite: (a) => void seen.push(`watch:${a.step}:${a.kind}`) });
    registerRunHooks("hold", { beforeWrite: () => ({ kind: "approval", reason: "a write needs a person" }), onHold: (a) => void seen.push(`hold:${a.hold.kind}`) });
    registerRunHooks("late", { beforeWrite: () => void seen.push("late"), onHold: () => void seen.push("late:onHold") });
    const ctx = { journey: {} as Journey, params: {}, channel: "cli", mode: undefined, evidence: undefined } satisfies RunHookContext;
    const err = await runBeforeWriteHooks({ ...ctx, step: 3, kind: "click", locator: {} as never }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunHeldError);
    expect(err).toMatchObject({ code: "E_RUN_HELD", owner: "hold", extra: { at: 3 } });
    expect(seen).toEqual(["watch:3:click", "hold:approval", "late:onHold"]);
  });

  it("with no beforeWrite hook the replay's guard is exactly the run guard", () => {
    const inner = { beforeAction: async () => undefined, afterStep: () => undefined };
    expect(withRunHookGuard(inner, () => ({}) as RunHookContext)).toBe(inner);
    expect(withRunHookGuard(undefined, () => ({}) as RunHookContext)).toBeUndefined();
    registerRunHooks("w", { beforeWrite: () => undefined });
    expect(withRunHookGuard(undefined, () => ({}) as RunHookContext)).toBeDefined();
  });
});
