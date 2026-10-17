import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import type { HttpCheck, Recording } from "@jevitate/recording";
import { buildProgram } from "./program.js";
import { EnvironmentConfigError, applyJourneyEnvironment, loadEnvironmentsFile, namedOriginMap, resolveJourneyEnvironment } from "./environments.js";

/**
 * #561 — a split-origin Journey moves between environments: named secondary origins declared by
 * both its source and target environments are mapped onto the target's origin for end-state http
 * checks, fixture step URLs, and the run's allowlist.
 */

const A = "http://127.0.0.1:3000";
const A_API = "http://127.0.0.1:6310";
const B = "http://127.0.0.1:3001";
const B_API = "http://127.0.0.1:26310";

const CHECK: HttpCheck = {
  kind: "http",
  method: "GET",
  url: `${A_API}/api/items`,
  json: [{ path: "$.count", op: "equals", value: "1" }],
};

const recording = (): Recording => ({ version: "1", site: A, pages: [] });

const journey = (check: HttpCheck = CHECK): Journey => ({
  metadata: { id: "login", name: "login", promoted: true, params: [], createdAtIso: "2026-09-28T00:00:00Z", endState: [check] },
  recording: recording(),
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-env-origins-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function envFile(content: unknown): string {
  const p = join(root, "environments.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
}

const file = (): string =>
  envFile({
    a: { baseUrl: A, origins: { api: A_API } },
    b: { baseUrl: B, origins: { api: B_API } },
  });

describe("#561 environments.json named origins", () => {
  it("parses named origins, normalizing each origin", () => {
    const envs = loadEnvironmentsFile(envFile({ a: { baseUrl: A, origins: { api: `${A_API}/` } } }));
    expect(envs.a?.origins).toEqual({ api: A_API });
  });

  it("refuses a named origin with a path, naming the environment and key", () => {
    expect(() => loadEnvironmentsFile(envFile({ a: { baseUrl: A, origins: { api: `${A_API}/api` } } }))).toThrow(
      /environments\.json\[a\]\.origins\.api .*must be an origin with no path/,
    );
  });

  it("refuses a named origin with a non-http scheme, naming the environment and key", () => {
    expect(() => loadEnvironmentsFile(envFile({ a: { baseUrl: A, origins: { api: "ftp://api.test" } } }))).toThrow(
      /environments\.json\[a\]\.origins\.api .*must be an http\(s\) origin/,
    );
  });

  it("refuses a bad origin name, naming the environment and key", () => {
    expect(() => loadEnvironmentsFile(envFile({ a: { baseUrl: A, origins: { "API!": A_API } } }))).toThrow(
      /environments\.json\[a\]\.origins\.API!: an origin name is 1-32 of/,
    );
  });

  it("still refuses unknown environment keys", () => {
    expect(() => loadEnvironmentsFile(envFile({ a: { baseUrl: A, extra: true } }))).toThrow(EnvironmentConfigError);
  });
});

describe("#561 mapping named origins onto a target environment", () => {
  const target = () => resolveJourneyEnvironment({ env: "b", environmentsFile: file(), targets: {} })!;

  it("rewrites an end-state http check URL on a named origin", () => {
    const out = applyJourneyEnvironment(journey(), target());
    expect(out.metadata.endState?.[0]).toEqual({ ...CHECK, url: `${B_API}/api/items` });
  });

  it("leaves the Journey's end state unchanged for its own source environment", () => {
    const out = applyJourneyEnvironment(journey(), resolveJourneyEnvironment({ env: "a", environmentsFile: file(), targets: {} }));
    expect(out.metadata.endState).toEqual([CHECK]);
  });

  it("does not rewrite an http check on an origin that is not a named origin of the source environment", () => {
    const other: HttpCheck = { ...CHECK, url: "http://127.0.0.1:9999/api/items" };
    const out = applyJourneyEnvironment(journey(other), target());
    expect(out.metadata.endState?.[0]).toEqual(other);
  });

  it("adds every target named origin to allowedOrigins", () => {
    expect(target().allowedOrigins).toContain(B_API);
  });

  it("exposes the target origins by name and maps the source origin", () => {
    const env = target();
    expect(namedOriginMap(env, A)).toEqual({ [A_API]: B_API });
  });

  it("maps nothing for a recorded site that matches no environment when none is named default", () => {
    expect(namedOriginMap(target(), "http://127.0.0.1:4000")).toEqual({});
  });

  it("falls back to the default environment for a recorded site that matches no environment", () => {
    const env = resolveJourneyEnvironment({
      env: "b",
      environmentsFile: envFile({ default: { baseUrl: A, origins: { api: A_API } }, b: { baseUrl: B, origins: { api: B_API } } }),
      targets: {},
    })!;
    expect(namedOriginMap(env, "http://127.0.0.1:4000")).toEqual({ [A_API]: B_API });
  });

  it("round-trips a resolved environment as plain JSON data", () => {
    const env = target();
    const round = JSON.parse(JSON.stringify(env)) as typeof env;
    expect(namedOriginMap(round, A)).toEqual(namedOriginMap(env, A));
  });

  it("--base-url without --env performs no origin mapping", () => {
    const env = resolveJourneyEnvironment({ baseUrl: B, targets: {} });
    const out = applyJourneyEnvironment(journey(), env);
    expect(out.metadata.endState).toEqual([CHECK]);
  });
});

describe("#561 fixture setup steps rebase named origins", () => {
  let server: Server;
  let target: string;
  const hits: string[] = [];
  beforeEach(async () => {
    hits.length = 0;
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("runs a fixture setup URL on the source named origin against the target environment's same-named origin", async () => {
    const dir = join(root, "journeys");
    await new JourneyRegistry(new FsJourneyStore(dir)).put({ ...journey(), metadata: { ...journey().metadata, endState: [] } });
    const fixture = join(root, "fixtures.json");
    writeFileSync(
      fixture,
      JSON.stringify({ setup: [{ method: "GET", url: `${A_API}/api/reset` }] }),
    );
    const opens: OpenOptions[] = [];
    const port: BrowserPort = {
      async open(o) {
        opens.push(o);
        return { page: { url: () => "about:blank" } as never, startTracing: async () => {}, stopTracingToFile: async () => {}, saveStorageState: async () => {}, admission: undefined, close: async () => {} };
      },
    };
    const lines: string[] = [];
    const environmentsFile = envFile({
      a: { baseUrl: A, origins: { api: A_API } },
      b: { baseUrl: B, origins: { api: target } },
    });
    const program = buildProgram({
      profiles: new ProfileManager("/unused"),
      dbPath: join(root, "db.sqlite"),
      environmentsFile,
      explore: { browserPortFactory: () => port, targetsConfigPath: join(root, "targets.json") },
    });
    program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
    program.exitOverride();
    await program.parseAsync(["journey", "run", "login", "--dir", dir, "--env", "b", "--fixtures", fixture, "--json"], { from: "user" });
    expect(hits).toEqual(["/api/reset"]);
  });
});
