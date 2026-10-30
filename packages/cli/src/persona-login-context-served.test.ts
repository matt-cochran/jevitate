import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import type { CliDeps } from "./cli-shared.js";
import { startMultiWorkspaceApp, type MultiWorkspaceApp } from "./fixtures/multi-workspace-app.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #741 served proof, REAL Chromium: a superadmin who belongs to several workspaces signs in to a
 * served app. Without a declared `context` the app offers its workspace chooser; with one, the
 * captured storage state carries the chosen organization/role, so reopening it lands directly on
 * the declared workspace — no chooser.
 */

class DoneJudge implements JudgmentPort {
  async systemOne(): Promise<Record<string, Answer>> {
    return { action: { kind: "choice", value: "done", confidence: 0.9 } };
  }
}

let app: MultiWorkspaceApp;
let dir: string;
/** A saved state minted with no declared context: the app offers its chooser on reopen. */
let chooserState: string;
/** A saved state minted for the "System Admin" role card rendered as a clickable button. */
let declaredState: string;

async function runLogin(argv: string[]): Promise<void> {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    profiles: new ProfileManager(join(dir, "profiles")),
    explore: {
      judge: new DoneJudge(),
      gen: new FakeGenerationGateway({}),
      env: { APP_USER: app.user, APP_PASSWORD: app.password },
      browserPortFactory: () => new PlaywrightBrowserPort(),
    },
  } as unknown as CliDeps;
  const program = buildProgram(deps);
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  const before = process.exitCode;
  process.exitCode = undefined;
  await program.parseAsync(argv, { from: "user" });
  process.exitCode = before;
  const text = out.join("").trimEnd().split("\n").at(-1) ?? "{}";
  const envelope = JSON.parse(text) as { ok: boolean; error?: { code: string; message: string } };
  if (!envelope.ok) throw new Error(`login failed: ${text}\n${err.join("")}`);
}

/** Declares one superadmin persona, optionally with a context, and mints its state through the CLI. */
async function mint(name: string, context?: { readonly organization?: string; readonly role?: string }): Promise<string> {
  const personas = join(dir, `${name}.personas.json`);
  const save = join(dir, `${name}.state.json`);
  await writeFile(
    personas,
    JSON.stringify({
      personas: [{ name: "superadmin", storageState: save, ...(context === undefined ? {} : { context }), login: { url: `${app.origin}/login`, userEnv: "APP_USER", passwordEnv: "APP_PASSWORD" } }],
    }),
  );
  await runLogin(["login", "--persona", "superadmin", "--personas", personas, "--save", save, "--json"]);
  return save;
}

/** Opens a fresh context seeded from `state`, lands on the app, and hands the page to `fn`. */
async function reopened<T>(state: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const session = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [app.origin], baseUrl: `${app.origin}/`, storageState: state });
  try {
    await session.page.goto(`${app.origin}/app`, { waitUntil: "load" });
    return await fn(session.page);
  } finally {
    await session.close();
  }
}

describe("#741 served multi-workspace superadmin context (real browser)", () => {
  beforeAll(async () => {
    app = await startMultiWorkspaceApp();
    dir = await mkdtemp(join(tmpdir(), "jev-multi-workspace-"));
    chooserState = await mint("chooser");
    declaredState = await mint("declared", { role: "System Admin" });
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("the served app shows the workspace chooser as role cards to a superadmin with no declared workspace", async () => {
    const offered = await reopened(chooserState, (page) => page.getByRole("button", { name: "System Admin" }).isVisible());
    expect(offered).toBe(true);
  }, 120_000);

  it("a saved state reopens directly in the declared organization with no chooser", async () => {
    const organization = await reopened(declaredState, (page) => page.locator("#workspace-org").textContent());
    expect(organization).toBe("System");
  }, 120_000);

  it("a saved state reopens directly in the declared role with no chooser", async () => {
    const role = await reopened(declaredState, (page) => page.locator("#workspace-role").textContent());
    expect(role).toBe("Admin");
  }, 120_000);
});
