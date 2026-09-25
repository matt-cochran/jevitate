import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, localStorageValue } from "./fixture-auth.js";
import { buildMissionFixtures, checkSetupRefs, checkUrlRefOrigin, invariantSetupTexts, regressionFixtures, substituteSpecSetupRefs } from "./fixture-cli.js";
import { loadInvariantFiles } from "./invariants-file.js";
import { loadTargetsFile, resolveTargetConfig } from "./target-config.js";
import {
  FixtureSetupError,
  FixtureSpecError,
  MissionFixtures,
  UnboundSetupRefError,
  fixtureReplayOpener,
  parseFixtureSpec,
  rebindReplayNavigation,
  selectJsonPath,
  substituteSetupRefs,
  type FixtureSpec,
} from "./mission-fixtures.js";

const ORIGIN = "http://127.0.0.1:4321";
const BOUNDS = { allowlist: [ORIGIN], baseUrl: `${ORIGIN}/app` };

const create = { method: "POST", url: "/api/items", json: { title: "t" }, outputs: { itemId: "$.id" } };
const remove = { method: "DELETE", url: "/api/items/${setup.itemId}" };

describe("parseFixtureSpec — validation (fail closed, before any request)", () => {
  it("accepts HTTP steps on an --allow origin, with outputs bound for later steps", () => {
    const spec = parseFixtureSpec({ setup: [create], teardown: [remove] }, BOUNDS);
    expect(spec.setup[0]?.outputs).toEqual({ itemId: "$.id" });
    expect(spec.restore[0]?.url).toBe("/api/items/${setup.itemId}");
  });

  it("rejects a step to an origin that is not --allow-listed", () => {
    expect(() => parseFixtureSpec({ setup: [{ method: "POST", url: "https://evil.example/seed" }] }, BOUNDS)).toThrow(/not an --allow origin/);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://127.0.0.1:4321/x", "data:text/plain,hi"])("rejects the non-HTTP URL %s", (url) => {
    expect(() => parseFixtureSpec({ setup: [{ method: "GET", url }] }, BOUNDS)).toThrow(FixtureSpecError);
  });

  it("rejects a ${setup.*} reference that would choose the origin", () => {
    expect(() => parseFixtureSpec({ setup: [create, { method: "GET", url: "http://${setup.itemId}/x" }] }, BOUNDS)).toThrow(FixtureSpecError);
    expect(() => checkUrlRefOrigin("http://${setup.host}/x")).toThrow(UnboundSetupRefError);
    expect(() => checkUrlRefOrigin(`${ORIGIN}/items/\${setup.itemId}`)).not.toThrow();
  });

  it.each([
    { setup: [{ method: "POST", url: "/seed", command: "rm -rf /" }] },
    { setup: [{ method: "POST", url: "/seed", auth: { from: "cookies", shell: "curl evil" } }] },
    { setup: [{ shell: "psql -c 'update ...'" }] },
    { setup: [create], run: "node seed.mjs" },
    { restore: [{ method: "DELETE", url: "/x", exec: ["sh", "-c", "x"] }] },
  ])("rejects a command in the file — shell hooks are operator flags only (%#)", (raw) => {
    expect(() => parseFixtureSpec(raw, BOUNDS)).toThrow(/cannot declare a command|operator's own flags/);
  });

  it("keeps request-body keys opaque (an app field named `command` is data, not a command)", () => {
    expect(() => parseFixtureSpec({ setup: [{ method: "POST", url: "/api/jobs", json: { command: "noop" } }] }, BOUNDS)).not.toThrow();
  });

  it("rejects literal credentials — auth comes from the run's session", () => {
    expect(() => parseFixtureSpec({ setup: [{ method: "POST", url: "/x", headers: { Authorization: "Bearer abc" } }] }, BOUNDS)).toThrow(/no literal credentials/);
  });

  it("rejects a reference no earlier setup step outputs, and bad output selectors", () => {
    expect(() => parseFixtureSpec({ setup: [{ method: "GET", url: "/items/${setup.nope}" }] }, BOUNDS)).toThrow(/no earlier setup step outputs/);
    expect(() => parseFixtureSpec({ setup: [{ method: "GET", url: "/x", outputs: { id: "id" } }] }, BOUNDS)).toThrow(FixtureSpecError);
    expect(() => parseFixtureSpec({ setup: [{ method: "GET", url: "/x", outputs: { id: "$.a" }, secretOutputs: ["other"] }] }, BOUNDS)).toThrow(/secretOutputs/);
    expect(() => parseFixtureSpec({ restore: [{ method: "GET", url: "/x", outputs: { id: "$.a" } }] }, BOUNDS)).toThrow(/only setup steps/);
  });

  it("rejects unknown keys, a bad method and an empty spec", () => {
    expect(() => parseFixtureSpec({ setup: [{ ...create, retries: 3 }] }, BOUNDS)).toThrow(/not a known step key/);
    expect(() => parseFixtureSpec({ setup: [{ method: "TRACE", url: "/x" }] }, BOUNDS)).toThrow(/method/);
    expect(() => parseFixtureSpec({}, BOUNDS)).toThrow(/at least one/);
    expect(() => parseFixtureSpec({ setup: [create], restore: [remove], teardown: [remove] }, BOUNDS)).toThrow(/not both/);
  });
});

describe("${setup.x} in --invariants (#187)", () => {
  const spec = {
    observe: { other: { probe: { as: "intruder", get: "/v1/products/${setup.projectId}" } } },
    capture: { piece: { url: { after: { control: { name: "/Save/i" } }, route: "/projects/${setup.projectId}/*" } } },
    invariants: [
      { id: "not-readable", require: "other == 404 || other == 403" },
      { id: "not-openable", when: { after: "capture.piece" }, deniedAs: { actor: "intruder", open: "/projects/${setup.projectId}/workbench" } },
    ],
  };
  const b = { values: { projectId: "p-42" }, secretNames: new Set<string>() };

  it("every ${setup.*}-bearing string is checked before the run, keyed by its JSON path", () => {
    expect(Object.keys(invariantSetupTexts(spec))).toEqual([
      "--invariants observe.other.probe.get",
      "--invariants capture.piece.url.route",
      "--invariants invariants[1].deniedAs.open",
    ]);
    expect(invariantSetupTexts(undefined)).toEqual({});
  });

  it("probe paths, capture routes and deniedAs.open are bound once setup ran", () => {
    const out = substituteSpecSetupRefs(spec, b, `${ORIGIN}/app`);
    expect(out.observe.other.probe.get).toBe("/v1/products/p-42");
    expect(out.capture.piece.url.route).toBe("/projects/p-42/*");
    expect(out.invariants[1]?.deniedAs?.open).toBe("/projects/p-42/workbench");
    expect(spec.observe.other.probe.get).toBe("/v1/products/${setup.projectId}");
  });

  it("a bound value never moves a probe off its origin; an unbound one is refused", () => {
    const evil = { values: { projectId: "/evil.test/x" }, secretNames: new Set<string>() };
    const s = { observe: { o: { probe: { get: "/${setup.projectId}" } } } };
    expect(() => substituteSpecSetupRefs(s, evil, `${ORIGIN}/app`)).toThrow(/never the origin/);
    expect(() => substituteSpecSetupRefs(s, { values: {}, secretNames: new Set<string>() }, `${ORIGIN}/app`)).toThrow(UnboundSetupRefError);
  });

  it("the invariants loader accepts a ${setup.*} probe path (validated before the browser)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inv-setup-"));
    try {
      const file = join(dir, "inv.json");
      await writeFile(file, JSON.stringify({ observe: { n: { probe: { get: "/v1/products/${setup.projectId}" } } }, invariants: [{ id: "a", require: "n == 404" }] }));
      expect(loadInvariantFiles([file], BOUNDS)?.observe?.n).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the --url refusal names the fix", () => {
    expect(() => checkUrlRefOrigin("http://127.0.0.1:4321${setup.pieceUrl}")).toThrow(/put it after a `\/`/);
  });
});

describe("output binding", () => {
  it("JSONPath-lite selects scalars", () => {
    const doc = { id: 7, invite: { url: "http://x/i/abc" }, tags: ["a", "b"], "odd key": true };
    expect(selectJsonPath(doc, "$.id")).toBe("7");
    expect(selectJsonPath(doc, "$.invite.url")).toBe("http://x/i/abc");
    expect(selectJsonPath(doc, "$.tags[1]")).toBe("b");
    expect(selectJsonPath(doc, '$["odd key"]')).toBe("true");
    expect(selectJsonPath(doc, "$.invite")).toBeUndefined();
    expect(selectJsonPath(doc, "$.missing.x")).toBeUndefined();
  });

  it("substitutes known outputs, refuses unknown names and keeps secret outputs out of model-visible text", () => {
    const b = { values: { itemId: "item-1", password: "pw" }, secretNames: new Set(["password"]) };
    expect(substituteSetupRefs("open /items/${setup.itemId}", b)).toBe("open /items/item-1");
    expect(() => substituteSetupRefs("${setup.other}", b)).toThrow(UnboundSetupRefError);
    expect(() => substituteSetupRefs("type ${setup.password}", b)).toThrow(/secret output/);
    expect(substituteSetupRefs("${setup.password}", b, { allowSecret: true })).toBe("pw");
  });

  it("checkSetupRefs refuses references the fixture does not declare, or a run without fixtures", () => {
    const fx = new MissionFixtures({ ...BOUNDS, spec: parseFixtureSpec({ setup: [create] }, BOUNDS), auth: {} });
    expect(() => checkSetupRefs({ "--goal": "open ${setup.itemId}" }, fx)).not.toThrow();
    expect(() => checkSetupRefs({ "--success": ["textIncludes:h1|${setup.nope}"] }, fx)).toThrow(/does not output/);
    expect(() => checkSetupRefs({ "--url": `${ORIGIN}/\${setup.itemId}` }, undefined)).toThrow(/no --fixtures/);
  });
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(calls: Call[], respond: (c: Call) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
}

describe("MissionFixtures — lifecycle", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-fixtures-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function spec(): FixtureSpec {
    return parseFixtureSpec(
      {
        setup: [
          {
            ...create,
            auth: { from: "localStorage", key: "token" },
            outputs: { itemId: "$.id", password: "$.password" },
            secretOutputs: ["password"],
          },
        ],
        restore: [{ ...remove, auth: { from: "localStorage", key: "token" } }],
      },
      BOUNDS,
    );
  }

  it("sets up, binds outputs (secret ones by name only), restores with them, and records an identity", async () => {
    const state = join(dir, "state.json");
    await writeFile(state, JSON.stringify({ cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "token", value: "tok-SECRET-1" }] }] }));
    const calls: Call[] = [];
    let n = 0;
    const fx = new MissionFixtures({
      ...BOUNDS,
      spec: spec(),
      auth: { storageStatePath: state },
      fetchImpl: fakeFetch(calls, (c) =>
        c.method === "POST" ? Response.json({ id: `item-${++n}0000`, password: "pw-SECRET" }, { status: 201 }) : new Response(null, { status: 204 }),
      ),
    });
    await fx.setup();
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-SECRET-1");
    expect(calls[0]?.body).toBe(JSON.stringify({ title: "t" }));
    expect(fx.publicOutputs()).toEqual({ itemId: "item-10000" });
    expect(fx.secrets()).toEqual(["pw-SECRET"]);
    const first = fx.identity();
    await fx.restore();
    expect(calls[1]).toMatchObject({ method: "DELETE", url: `${ORIGIN}/api/items/item-10000` });
    await fx.restore(); // idempotent
    expect(calls).toHaveLength(2);

    const rec = fx.record();
    expect(rec.secretOutputs).toEqual(["password"]);
    expect(JSON.stringify(rec)).not.toContain("SECRET");
    expect(rec.log.map((l) => `${l.phase}:${l.ok}`)).toEqual(["setup:true", "restore:true"]);

    // A replay cycle: restore (nothing active) + setup afresh → a new id, a new identity, same spec hash.
    await fx.reset();
    expect(fx.publicOutputs()).toEqual({ itemId: "item-20000" });
    expect(fx.identity()).not.toBe(first);
    expect(fx.record().cycles).toBe(2);
  });

  it("a failed step throws `fixture setup failed: …` (no secret in it) and restore still runs", async () => {
    const calls: Call[] = [];
    const fx = new MissionFixtures({
      ...BOUNDS,
      spec: parseFixtureSpec({ setup: [create, { method: "POST", url: "/api/items/${setup.itemId}/publish" }], restore: [remove] }, BOUNDS),
      auth: {},
      fetchImpl: fakeFetch(calls, (c) => (c.url.endsWith("/publish") ? new Response("nope", { status: 500 }) : Response.json({ id: "item-abc" }))),
    });
    const err = await fx.setup().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixtureSetupError);
    expect((err as Error).message).toMatch(/^fixture setup failed: setup\[1\]: POST .*\/api\/items\/item-abc\/publish answered 500/);
    await fx.restore();
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("#166: a login step puts ${secretField.VAR} in its JSON body only; its secret token authenticates the next step", async () => {
    // The in-memory-token SPA: log in with the --secret-field password, capture the token as a
    // secret output, reset state through the API with it.
    const raw = {
      setup: [
        { name: "login", method: "POST", url: "/Login", json: { email: "qa@example.test", password: "${secretField.APP_PASSWORD}" }, outputs: { token: "$.data" }, secretOutputs: ["token"] },
        { name: "reset", method: "POST", url: "/api/v1/tool/profile", headers: { Authorization: "Bearer ${setup.token}" }, body: "reset=${secretField.APP_PASSWORD}" },
      ],
    };
    const calls: Call[] = [];
    const fx = new MissionFixtures({
      ...BOUNDS,
      spec: parseFixtureSpec(raw, BOUNDS),
      auth: { secretFields: { APP_PASSWORD: "pw-SECRET-166" } },
      fetchImpl: fakeFetch(calls, (c) => (c.url.endsWith("/Login") ? Response.json({ data: "tok-SECRET-166" }) : new Response(null, { status: 204 }))),
    });
    await fx.setup();
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ email: "qa@example.test", password: "pw-SECRET-166" });
    expect(calls[1]?.headers.Authorization).toBe("Bearer tok-SECRET-166");
    expect(calls[1]?.body).toBe("reset=pw-SECRET-166");
    // Never in the recorded log, the result record or what a replay persists.
    for (const out of [fx.record(), fx.persisted()]) expect(JSON.stringify(out)).not.toMatch(/SECRET-166/);
    expect(JSON.stringify(fx.persisted())).toContain("${secretField.APP_PASSWORD}");

    // A failing step's detail is redacted too.
    const failing = new MissionFixtures({
      ...BOUNDS,
      spec: parseFixtureSpec({ setup: [{ method: "POST", url: "/Login", json: { p: "${secretField.APP_PASSWORD}" } }] }, BOUNDS),
      auth: { secretFields: { APP_PASSWORD: "pw-SECRET-166" } },
      fetchImpl: (async () => {
        throw new Error("socket hang up sending pw-SECRET-166");
      }) as unknown as typeof fetch,
    });
    const err = await failing.setup().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/fixture setup failed/);
    expect((err as Error).message).not.toContain("pw-SECRET-166");
    expect(JSON.stringify(failing.record())).not.toContain("pw-SECRET-166");
  });

  it("#166: an unknown ${secretField.VAR} is refused at validation; a secret never goes in a URL or a public credential header", () => {
    const spec = parseFixtureSpec({ setup: [{ method: "POST", url: "/Login", json: { password: "${secretField.NOPE}" } }] }, BOUNDS);
    expect(() => new MissionFixtures({ ...BOUNDS, spec, auth: { secretFields: { APP_PASSWORD: "x" } } })).toThrow(
      /references \$\{secretField\.NOPE\}, but the run has no --secret-field bound to env:NOPE/,
    );
    expect(() => buildMissionFixtures({}, { ...BOUNDS, spec })).toThrow(FixtureSpecError);
    expect(() => parseFixtureSpec({ setup: [{ method: "GET", url: "/x?p=${secretField.APP_PASSWORD}" }] }, BOUNDS)).toThrow(/allowed only in json, body or headers/);
    expect(() =>
      parseFixtureSpec(
        { setup: [{ method: "POST", url: "/Login", outputs: { token: "$.data" } }, { method: "GET", url: "/me", headers: { Authorization: "Bearer ${setup.token}" } }] },
        BOUNDS,
      ),
    ).toThrow(/carries a credential — list it in secretOutputs/);
    expect(() => parseFixtureSpec({ setup: [{ method: "GET", url: "/me", headers: { "X-Api-Key": "${secretField.API_KEY}" } }] }, BOUNDS)).not.toThrow();
    expect(() => parseFixtureSpec({ setup: [{ method: "GET", url: "/me", headers: { Authorization: "Bearer abc${secretField.K}" } }] }, BOUNDS)).toThrow(/no literal credentials/);
  });

  it("auth from a missing source fails setup rather than running unauthenticated", async () => {
    const fx = new MissionFixtures({
      ...BOUNDS,
      spec: parseFixtureSpec({ setup: [{ ...create, auth: { from: "cookies" } }] }, BOUNDS),
      auth: {},
      fetchImpl: fakeFetch([], () => Response.json({ id: "x" })),
    });
    await expect(fx.setup()).rejects.toThrow(/needs --storage-state/);
  });

  it("shell hooks need --allow-shell-hooks; --before binds {vars, secret}; exit codes and redacted stderr are logged", async () => {
    expect(() => new MissionFixtures({ ...BOUNDS, hooks: { before: "true" }, auth: {} })).toThrow(/--allow-shell-hooks/);
    const fx = new MissionFixtures({
      ...BOUNDS,
      hooks: {
        before: `node -e "console.error('seeded HOOKSECRET'); console.log(JSON.stringify({vars:{pieceId:'ws-123456',pw:'hook-pw'},secret:['pw']}))"`,
        after: "node -e \"process.exit(3)\"",
      },
      allowShellHooks: true,
      secrets: ["HOOKSECRET"],
      auth: {},
    });
    await fx.setup();
    expect(fx.publicOutputs()).toEqual({ pieceId: "ws-123456" });
    expect(fx.secrets()).toEqual(["hook-pw"]);
    await fx.restore();
    const log = fx.record().log;
    expect(log[0]).toMatchObject({ kind: "shell", name: "--before", ok: true, exitCode: 0 });
    expect(log[0]?.stderr).toContain("seeded «redacted»");
    expect(log[1]).toMatchObject({ kind: "shell", name: "--after", ok: false, exitCode: 3 });
    expect(JSON.stringify(log)).not.toContain("hook-pw");
  });

  it("a failing or non-JSON --before hook is a setup failure", async () => {
    const failing = new MissionFixtures({ ...BOUNDS, hooks: { before: 'node -e "process.exit(2)"' }, allowShellHooks: true, auth: {} });
    await expect(failing.setup()).rejects.toThrow(/fixture setup failed: the --before hook exited 2/);
    const garbage = new MissionFixtures({ ...BOUNDS, hooks: { before: "echo not-json" }, allowShellHooks: true, auth: {} });
    await expect(garbage.setup()).rejects.toThrow(/other than one JSON object/);
  });

  it("regression capture: a Recording made from a fixture is never replayed without one; --result supplies the saved spec", () => {
    const recording = { site: ORIGIN, fixture: { identity: "fx-1" } };
    expect(() => regressionFixtures({}, recording, undefined)).toThrow(/started from fixture fx-1/);
    expect(regressionFixtures({}, { site: ORIGIN }, undefined)).toBeUndefined();
    const result = { result: { target: { seedUrl: `${ORIGIN}/app`, allowlist: [ORIGIN] }, fixtures: { identity: "fx-1", spec: { setup: [create], restore: [remove] } } } };
    expect(regressionFixtures({}, recording, result)?.declaredOutputs()).toEqual(new Set(["itemId"]));
    // A saved spec is re-validated against the mission's allowlist, never trusted as-is.
    const tampered = { result: { ...result.result, fixtures: { identity: "fx-1", spec: { setup: [{ method: "POST", url: "https://evil.test/x" }] } } } };
    expect(() => regressionFixtures({}, recording, tampered)).toThrow(/not an --allow origin/);
    const hooked = { result: { ...result.result, fixtures: { identity: "fx-1", hooks: { before: "abc" } } } };
    expect(() => regressionFixtures({}, recording, hooked)).toThrow(/re-supply the SAME commands/);
  });

  it("buildMissionFixtures loads --fixtures and refuses a spec that leaves the allowlist", async () => {
    const file = join(dir, "fixtures.json");
    await writeFile(file, JSON.stringify({ setup: [{ method: "POST", url: "https://elsewhere.test/seed" }] }));
    expect(() => buildMissionFixtures({ fixtures: file }, BOUNDS)).toThrow(/not an --allow origin/);
    expect(buildMissionFixtures({}, BOUNDS)).toBeUndefined();
  });

  it("a target's `fixtures` in targets.json resolves against the file's directory", async () => {
    const targets = join(dir, "targets.json");
    await writeFile(targets, JSON.stringify({ [ORIGIN]: { fixtures: "fx/seed.json" } }));
    expect(resolveTargetConfig(loadTargetsFile(targets), ORIGIN).fixtures).toBe(join(dir, "fx/seed.json"));
    await writeFile(targets, JSON.stringify({ [ORIGIN]: { fixtures: 3 } }));
    expect(() => loadTargetsFile(targets)).toThrow(/fixtures must be a file path/);
  });
});

describe("authHeaders", () => {
  it("reads a bearer from localStorage, matching cookies, or a --secret-field binding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-auth-"));
    try {
      const state = join(dir, "s.json");
      await writeFile(
        state,
        JSON.stringify({
          cookies: [
            { name: "sid", value: "c1", domain: "127.0.0.1", path: "/" },
            { name: "other", value: "c2", domain: "elsewhere.test", path: "/" },
          ],
          origins: [{ origin: ORIGIN, localStorage: [{ name: "jwt", value: "t1" }] }],
        }),
      );
      expect(authHeaders({ from: "localStorage", key: "jwt", scheme: "Token", header: "x-auth" }, `${ORIGIN}/a`, { storageStatePath: state })).toEqual({ "x-auth": "Token t1" });
      expect(authHeaders({ from: "cookies" }, `${ORIGIN}/a`, { storageStatePath: state })).toEqual({ cookie: "sid=c1" });
      expect(authHeaders({ from: "secretField", name: "API_KEY", scheme: "" }, `${ORIGIN}/a`, { secretFields: { API_KEY: "k1" } })).toEqual({ authorization: "k1" });
      expect(() => authHeaders({ from: "localStorage", key: "missing" }, `${ORIGIN}/a`, { storageStatePath: state })).toThrow(/no localStorage "missing"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("localStorageValue (#173)", () => {
  it("reads a storageState file's localStorage[key] for an origin, straight from the file — no browser needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-auth-ls-"));
    try {
      const state = join(dir, "b.json");
      await writeFile(
        state,
        JSON.stringify({
          cookies: [],
          origins: [{ origin: ORIGIN, localStorage: [{ name: "simuli_token", value: "SECRET-MEMBER-JWT" }] }],
        }),
      );
      expect(localStorageValue(state, ORIGIN, "simuli_token")).toBe("SECRET-MEMBER-JWT");
      // No entry for that key, that origin, or an unreadable file: null, never a throw (the caller
      // fails the probe closed the same way an unavailable token from any other source does).
      expect(localStorageValue(state, ORIGIN, "missing-key")).toBeNull();
      expect(localStorageValue(state, "http://elsewhere.test", "simuli_token")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("replay rebinding", () => {
  it("rewrites the recorded output values in a replay's navigations to the fresh setup's", async () => {
    const seen: string[] = [];
    const page = { goto: async (url: string) => void seen.push(url) };
    rebindReplayNavigation(page, { itemId: "item-old1", n: "7" }, { itemId: "item-new2", n: "8" });
    await page.goto(`${ORIGIN}/items/item-old1?x=1`);
    await page.goto(`${ORIGIN}/n/7`);
    expect(seen).toEqual([`${ORIGIN}/items/item-new2?x=1`, `${ORIGIN}/n/7`]);
  });

  it("fixtureReplayOpener resets the fixture before opening each replay session", async () => {
    let n = 0;
    const fx = new MissionFixtures({
      ...BOUNDS,
      spec: parseFixtureSpec({ setup: [create], restore: [remove] }, BOUNDS),
      auth: {},
      fetchImpl: fakeFetch([], (c) => (c.method === "POST" ? Response.json({ id: `item-${++n}xyz` }) : new Response(null, { status: 204 }))),
    });
    await fx.setup();
    const recorded = fx.publicOutputs();
    const gotos: string[] = [];
    const open = fixtureReplayOpener(async () => ({ page: { goto: async (u: string) => void gotos.push(u) } }), fx, recorded);
    const s = await open();
    await s.page.goto(`${ORIGIN}/items/item-1xyz`);
    expect(gotos).toEqual([`${ORIGIN}/items/item-2xyz`]);
    expect(fx.record().log.map((l) => l.phase)).toEqual(["setup", "restore", "setup"]);
  });
});
