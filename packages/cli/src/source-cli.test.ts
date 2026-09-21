import { expect, test } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import type { Journey } from "@jevitate/journey";
import type { GhPort, GitExec, JevitateManifest, SharedJourneyFile } from "@jevitate/sources";
import { buildProgram, type CliDeps } from "./program.js";

/**
 * End-to-end CLI tests for `jevitate source` (#18) and `jevitate journey
 * publish` (#19), driving the real `buildProgram` with injected sources ports
 * (fake git/gh, temp dirs) — never the network. Browser-free and fast, kept
 * out of `program.test.ts` (which carries a known full-suite timeout flake).
 */

const ORIGIN = "https://shop.test";

const MANIFEST: JevitateManifest = {
  version: 1,
  source: "shop",
  sites: [{ origin: ORIGIN, automationPolicy: "allowed", touBasis: "public terms" }],
};

function sharedJourney(id: string, risky = false): SharedJourneyFile {
  const steps: SharedJourneyFile["recording"]["pages"][number]["steps"] = [
    { step: { kind: "navigate", url: `${ORIGIN}/`, expect: { kind: "visible", target: { label: "Home" } } } },
  ];
  if (risky) steps.push({ step: { kind: "click", target: { role: "button", name: "Buy" }, expect: { kind: "visible", target: { testId: "cart" } } } });
  return {
    metadata: { id, name: id, description: "shared", promoted: true, params: [], createdAtIso: "2026-01-01T00:00:00Z" },
    recording: { version: "1.0.0", site: ORIGIN, pages: [{ url: "/", steps }] },
    declaredOrigins: [ORIGIN],
  };
}

function localJourney(id: string, opts: { promoted?: boolean; secret?: boolean } = {}): Journey {
  const steps: Journey["recording"]["pages"][number]["steps"] = [
    { step: { kind: "navigate", url: `${ORIGIN}/`, expect: { kind: "visible", target: { label: "Home" } } } },
  ];
  if (opts.secret) {
    steps.push({ step: { kind: "fill", target: { label: "Password" }, value: { redacted: false, value: "hunter2" }, expect: { kind: "visible", target: { testId: "ok" } } } });
  }
  return {
    metadata: { id, name: id, description: "local", promoted: opts.promoted ?? true, params: [], createdAtIso: "2026-01-01T00:00:00Z" },
    recording: { version: "1.0.0", site: ORIGIN, pages: [{ url: "/", steps }] },
  };
}

async function seedRemote(dir: string, files: SharedJourneyFile[]): Promise<void> {
  await writeFile(join(dir, "jevitate.json"), JSON.stringify(MANIFEST));
  await mkdir(join(dir, "journeys"), { recursive: true });
  for (const f of files) await writeFile(join(dir, "journeys", `${f.metadata.id}.journey.json`), JSON.stringify(f));
}

function makeFakeGit(seed?: (dir: string) => Promise<void>): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitExec = async (args) => {
    calls.push(args);
    if (args[0] === "clone") {
      await mkdir(args[2], { recursive: true });
      if (seed) await seed(args[2]);
      return { stdout: "" };
    }
    if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n` };
    return { stdout: "" };
  };
  return { git, calls };
}

async function newProgram(sources: NonNullable<CliDeps["sources"]>) {
  const root = await mkdtemp(join(tmpdir(), "source-cli-"));
  const profiles = new ProfileManager("/unused");
  const lines: string[] = [];
  const program = buildProgram({
    profiles,
    sources: {
      sourcesDir: join(root, "sources"),
      lockPath: join(root, "jevitate.lock"),
      trustDir: join(root, "trust"),
      ackDir: join(root, "trust", "acks"),
      approvedBy: "matthew",
      now: () => "2026-01-01T00:00:00Z",
      ...sources,
    },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, root };
}

function parse(lines: string[]) {
  return JSON.parse(lines.join(""));
}

const ghAbsent: GhPort = { available: async () => false, createPr: async () => "" };

test("source add --json clones, pins, surfaces ToU, and does not ack without --accept-tou", async () => {
  const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("checkout")]));
  const { program, lines } = await newProgram({ git });
  await program.parseAsync(["source", "add", "shop", "https://git.test/shop.git", "--json"], { from: "user" });
  const env = parse(lines);
  expect(env.ok).toBe(true);
  expect(env.data.pinnedCommit).toBe("a".repeat(40));
  expect(env.data.touAccepted).toBe(false);
});

test("source trust then list --json shows the trusted journey; unknown source -> E_SOURCE_UNKNOWN", async () => {
  const { git } = makeFakeGit((d) => seedRemote(d, [sharedJourney("risky", true)]));
  const { program, lines, root } = await newProgram({ git });
  await program.parseAsync(["source", "add", "shop", "https://git.test/shop.git", "--json"], { from: "user" });
  lines.length = 0;
  await program.parseAsync(["source", "trust", "shop", "risky", "--json"], { from: "user" });
  const trustEnv = parse(lines);
  expect(trustEnv.ok).toBe(true);
  expect(trustEnv.data.contentHash).toMatch(/^sha256:/);
  expect(trustEnv.data.approvedBy).toBe("matthew");

  lines.length = 0;
  await program.parseAsync(["source", "list", "--json"], { from: "user" });
  const listEnv = parse(lines);
  expect(listEnv.data[0].trustedJourneys).toEqual(["risky"]);

  // Second program instance sharing the same dirs, to exercise unknown source.
  const profiles2 = await import("@jevitate/daemon");
  const lines2: string[] = [];
  const program2 = buildProgram({
    profiles: new profiles2.ProfileManager("/unused"),
    sources: { sourcesDir: join(root, "sources"), lockPath: join(root, "jevitate.lock"), trustDir: join(root, "trust"), ackDir: join(root, "trust", "acks"), git },
  });
  program2.configureOutput({ writeOut: (s) => lines2.push(s) });
  program2.exitOverride();
  await program2.parseAsync(["source", "pull", "ghost", "--json"], { from: "user" });
  const err = parse(lines2);
  expect(err.ok).toBe(false);
  expect(err.error.code).toBe("E_SOURCE_UNKNOWN");
});

test("journey publish --json publishes a promoted journey (gh absent -> instructions)", async () => {
  const { git, calls } = makeFakeGit((d) => seedRemote(d, []));
  const { program, lines, root } = await newProgram({ git, gh: ghAbsent });
  await program.parseAsync(["source", "add", "shop", "https://git.test/shop.git", "--json"], { from: "user" });
  const journeysDir = join(root, "journeys");
  await mkdir(journeysDir, { recursive: true });
  await writeFile(join(journeysDir, "checkout.json"), JSON.stringify(localJourney("checkout")));

  lines.length = 0;
  await program.parseAsync(["journey", "publish", "checkout", "--to", "shop", "--dir", journeysDir, "--json"], { from: "user" });
  const env = parse(lines);
  expect(env.ok).toBe(true);
  expect(env.data.branch).toBe("publish/checkout");
  expect(env.data.instructions).toBeTruthy();
  expect(calls).toContainEqual(["push", "-u", "origin", "publish/checkout"]);
});

test("SECURITY: journey publish refuses a materialized secret -> E_JOURNEY_PUBLISH_SECRET (no push)", async () => {
  const { git, calls } = makeFakeGit((d) => seedRemote(d, []));
  const { program, lines, root } = await newProgram({ git, gh: ghAbsent });
  await program.parseAsync(["source", "add", "shop", "https://git.test/shop.git", "--json"], { from: "user" });
  const journeysDir = join(root, "journeys");
  await mkdir(journeysDir, { recursive: true });
  await writeFile(join(journeysDir, "login.json"), JSON.stringify(localJourney("login", { secret: true })));

  lines.length = 0;
  await program.parseAsync(["journey", "publish", "login", "--to", "shop", "--dir", journeysDir, "--json"], { from: "user" });
  const env = parse(lines);
  expect(env.ok).toBe(false);
  expect(env.error.code).toBe("E_JOURNEY_PUBLISH_SECRET");
  expect(calls.some((c) => c[0] === "push")).toBe(false);
});

test("journey publish refuses an unpromoted journey -> E_JOURNEY_PUBLISH_NOT_PROMOTED", async () => {
  const { git } = makeFakeGit((d) => seedRemote(d, []));
  const { program, lines, root } = await newProgram({ git, gh: ghAbsent });
  await program.parseAsync(["source", "add", "shop", "https://git.test/shop.git", "--json"], { from: "user" });
  const journeysDir = join(root, "journeys");
  await mkdir(journeysDir, { recursive: true });
  await writeFile(join(journeysDir, "draft.json"), JSON.stringify(localJourney("draft", { promoted: false })));

  lines.length = 0;
  await program.parseAsync(["journey", "publish", "draft", "--to", "shop", "--dir", journeysDir, "--json"], { from: "user" });
  const env = parse(lines);
  expect(env.ok).toBe(false);
  expect(env.error.code).toBe("E_JOURNEY_PUBLISH_NOT_PROMOTED");
});
