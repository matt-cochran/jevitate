import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretFieldSpecError, parseSecretField } from "@jevitate/explore";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { BoundSecretOutsideFieldError, secretParamNamesArgvWarning, withCommandSecretParams, withSecretParamsFor } from "./secret-params.js";
import { loadTargetsFile } from "./target-config.js";
import { BranchReplayInputError, prefixFromBranch, type RecordedBranch } from "./journey-prefix.js";

/**
 * #819 and #827, unit: `param=<name>` binds a secret parameter by name (a token in a navigate URL
 * included), a binding for one origin never sends it to another, a command that replays several Journeys
 * takes a flag that binds any of them, and the `--param` warning names a route that works.
 */

const SITE = "https://app.example";
const ENV = { TOK: "tok-value-1", PW: "pw-value-2" };
let dir: string;

function journey(id: string, steps: unknown[], params: string[]): Journey {
  return {
    metadata: { id, name: id, promoted: true, params, parameters: params.map((name) => ({ name, secret: true })), createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: { version: "1", site: SITE, pages: [{ url: "/", steps: steps.map((step) => ({ step })) }] },
  } as unknown as Journey;
}

const seen = { kind: "visible", target: { role: "heading", name: "Welcome" } };
const invite = journey("invite", [{ kind: "navigate", url: "/invite/${inviteToken}", expect: seen }], ["inviteToken"]);
const inviteElsewhere = journey("invite-elsewhere", [{ kind: "navigate", url: "https://other.example/invite/${inviteToken}", expect: seen }], ["inviteToken"]);
const login = journey("login", [{ kind: "navigate", url: "/login", expect: seen }, { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: seen }], ["password"]);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "jev-secret-routes-"));
  for (const j of [invite, inviteElsewhere, login]) await new FsJourneyStore(dir).put(j);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = (over: Partial<Parameters<typeof withSecretParamsFor>[1]> = {}): Parameters<typeof withSecretParamsFor>[1] => ({ id: "invite", params: {}, flags: [], targetFields: undefined, targetOrigin: undefined, env: ENV, ...over });

describe("#819 param=<name>", () => {
  it("parses everywhere a binding is read, and never matches a live field", () => {
    expect(parseSecretField("param=inviteToken=env:TOK", "value", ENV).matcher).toEqual({ key: "param", value: "inviteToken" });
    const file = join(dir, "targets.json");
    writeFileSync(file, JSON.stringify({ [SITE]: { secretFields: ["param=inviteToken=env:TOK"] } }));
    expect(loadTargetsFile(file)[SITE]?.secretFields).toEqual(["param=inviteToken=env:TOK"]);
  });

  it("a flag supplies a navigate URL's secret, bound to the run's allowlist", () => {
    expect(withSecretParamsFor(invite, req({ flags: ["param=inviteToken=env:TOK"] }))).toEqual({ params: { inviteToken: "tok-value-1" }, bound: { inviteToken: "allowlist" } });
  });

  it("targets.json supplies it bound to that origin, and a relative URL is the run's own origin", () => {
    expect(withSecretParamsFor(invite, req({ targetFields: ["param=inviteToken=env:TOK"], targetOrigin: SITE }))).toEqual({ params: { inviteToken: "tok-value-1" }, bound: { inviteToken: [SITE] } });
  });

  it("a targets.json binding never sends it to another origin's URL: refused before anything runs, naming origins, never the value", () => {
    let err: unknown;
    try {
      withSecretParamsFor(inviteElsewhere, req({ id: "invite-elsewhere", targetFields: ["param=inviteToken=env:TOK"], targetOrigin: SITE }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BoundSecretOutsideFieldError);
    expect((err as BoundSecretOutsideFieldError).code).toBe("E_SECRET_ORIGIN_REFUSED");
    expect((err as Error).message).toContain("https://other.example");
    expect((err as Error).message).not.toContain("tok-value-1");
  });

  it("a field binding and a param binding for the same parameter cannot say which wins: refused", () => {
    expect(() => withSecretParamsFor(login, req({ id: "login", flags: ["label=Password=env:PW", "param=password=env:TOK"] }))).toThrow(/cannot say which value/);
  });

  it("the --param warning names the param= route, the command's own, and holds no value", () => {
    const w = secretParamNamesArgvWarning(["inviteToken"], "journey verify");
    expect(w).toContain("`jevitate journey verify` reads it from the environment instead: --secret-field 'param=inviteToken=env:<VAR>'");
    expect(w).toContain("navigate URL");
    expect(secretParamNamesArgvWarning(["inviteToken"])).toContain("`jevitate journey run` reads it");
  });
});

describe("#827 a command that replays one or more Journeys", () => {
  it("binds each Journey's own secret parameters, and a flag may be for either", async () => {
    const r = await withCommandSecretParams({ dir, ids: ["invite", "login"], params: {}, flags: ["param=inviteToken=env:TOK", "label=Password=env:PW"], env: ENV });
    expect(r.params).toEqual({ inviteToken: "tok-value-1", password: "pw-value-2" });
    expect(r.bound).toEqual({ inviteToken: "allowlist", password: "allowlist" });
  });

  it("an explicit --param wins over a binding", async () => {
    const r = await withCommandSecretParams({ dir, ids: ["login"], params: { password: "given" }, flags: [], environment: { secretFields: ["label=Password=env:PW"], baseUrl: SITE }, env: ENV });
    expect(r.params).toEqual({ password: "given" });
  });

  it("a flag that binds none of them is refused, naming it; strict: false leaves it to the caller", async () => {
    await expect(withCommandSecretParams({ dir, ids: ["login"], params: {}, flags: ["param=nope=env:PW"], env: ENV })).rejects.toThrow(/param=nope/);
    const loose = await withCommandSecretParams({ dir, ids: ["login"], params: {}, flags: ["label=Password=env:PW", "label=Code=env:TOK"], env: ENV, strict: false });
    expect(loose.used).toEqual(["label=Password=env:PW"]);
  });

  it("a malformed spec or an unset variable is refused whatever the Journeys, never echoing a value", async () => {
    await expect(withCommandSecretParams({ dir, ids: ["login"], params: {}, flags: ["label=Password=env:UNSET"], env: ENV })).rejects.toBeInstanceOf(SecretFieldSpecError);
    await expect(withCommandSecretParams({ dir, ids: ["login"], params: {}, flags: ["label=Password=hunter2"], env: ENV })).rejects.toThrow(/expects/);
  });
});

describe("#827 regression and verify-fix: a finding's prefix takes a binding", () => {
  const branch = (): RecordedBranch => ({ journeyId: "invite", step: 1, replay: { journeysDir: dir, params: {}, secretParams: ["inviteToken"] } }) as unknown as RecordedBranch;

  it("--secret-field supplies the prefix's secret parameter, and the prefix redacts it", async () => {
    const prefix = await prefixFromBranch(branch(), { secretFields: ["param=inviteToken=env:TOK"], env: ENV, command: "verify-fix" });
    expect(prefix.secrets).toContain("tok-value-1");
    expect(JSON.stringify(prefix.replayInfo)).not.toContain("tok-value-1");
  });

  it("with no binding, the refusal names the route off the command line", async () => {
    const err = await prefixFromBranch(branch(), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchReplayInputError);
    expect((err as Error).message).toContain("--secret-field 'param=inviteToken=env:<VAR>'");
  });
});
