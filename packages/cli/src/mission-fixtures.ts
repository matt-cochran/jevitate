/**
 * Mission fixtures (#140 declarative app setup, #144 setup/restore around missions and replays) —
 * ONE capability: put the app into a known state before a mission, bind what that setup created
 * (an item id, an invite URL) into the run as `${setup.<name>}`, restore the state afterwards, and
 * do the same around EVERY replay (hang reproduction, `verify-fix`, regression capture) so a replay
 * starts from the state the finding was made in, not whatever earlier runs left behind.
 *
 * Two step kinds, both operator-declared:
 *
 *  - HTTP steps, from a fixtures JSON file (`--fixtures`, or `fixtures` in `~/.jevitate/targets.json`).
 *    Only to an `--allow`-listed http(s) origin; authenticated like the page is (`fixture-auth.ts`:
 *    a storageState localStorage bearer, its cookies, or a `--secret-field` binding). A file can
 *    never declare a command. A step's json/body/headers may use `${secretField.<VAR>}` (#166) —
 *    the run's `--secret-field` value bound to env `<VAR>`, so a login step can authenticate; it
 *    is put on the wire only (never in a URL, the step log, the result or the Recording).
 *  - Shell hooks, from the operator's own CLI flags only (`--before <cmd>` / `--after <cmd>`, and
 *    only with `--allow-shell-hooks`). Never model-chosen, never read from a file a run wrote. Exit
 *    codes are recorded; stdout is never persisted (it may carry `{vars, secret}`), stderr only
 *    redacted and clipped.
 *
 * Fail closed: a setup that fails, times out, or leaves a `${setup.x}` reference unresolved ends
 * the run `inconclusive` (`fixture setup failed: …`, a configuration error) — a mission never runs
 * on unknown state. Secret outputs join the run's redaction set and may only be used inside the
 * fixture's own requests, never in text a model sees.
 */

import { isSecretName } from "@jevitate/journey";
import { spawn } from "node:child_process";
import { redactText, redactUrl } from "@jevitate/ai-core";
import { clock, isRecord, sha256 } from "@jevitate/domain";
import { authHeaders } from "./fixture-auth.js";
import {
  CREDENTIAL_HEADERS,
  OUTPUT_NAME,
  OUTPUT_REF,
  SECRET_FIELD_REF,
  assertStepUrl,
  canonical,
  clip,
  fixtureSpecHash,
  firstLine,
  hookHash,
  selectJsonPath,
  stringsIn,
  substituteDeep,
  substituteStepText,
} from "./mission-fixtures-spec.js";
import {
  FixtureSetupError,
  FixtureSpecError,
  UnboundRestoreRefError,
  UnboundSetupRefError,
  type FixtureBindings,
  type FixtureHttpStep,
  type FixtureRecord,
  type FixtureRunOptions,
  type FixtureSpec,
  type FixtureStepLog,
  type HookResult,
  type PersistedFixtures,
} from "./mission-fixtures-types.js";

/** @public The fixture surface this module has always exported; some names have no in-repo caller. */
export { SETUP_REF } from "./mission-fixtures-spec.js";
/** @public */
export { SECRET_FIELD_REF, referencedNames, parseFixtureSpec, loadFixtureFile, parseJsonPath, selectJsonPath, substituteSetupRefs, fixtureSpecHash, hookHash } from "./mission-fixtures-spec.js";
/** @public */
export { FixtureSpecError, FixtureSetupError, UnboundSetupRefError, UnboundRestoreRefError } from "./mission-fixtures-types.js";
export type { FixtureHttpStep, FixtureSpec, ShellHooks, FixtureBounds, FixtureBindings, FixtureStepLog, FixtureRecord, PersistedFixtures, FixtureRunOptions } from "./mission-fixtures-types.js";

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_STDOUT = 64 * 1024;

/**
 * Every `--secret-field` env variable a spec needs (#166): the `auth: {from: "secretField"}` names
 * and every `${secretField.<VAR>}` in a step's json/body/headers.
 */
export function secretFieldNames(spec: FixtureSpec | undefined): string[] {
  const names = new Set<string>();
  for (const s of [...(spec?.setup ?? []), ...(spec?.restore ?? [])]) {
    if (s.auth?.from === "secretField") names.add(s.auth.name);
    for (const text of stringsIn([s.headers ?? {}, s.json ?? null, s.body ?? ""])) {
      for (const m of text.matchAll(SECRET_FIELD_REF)) names.add(m[1] as string);
    }
  }
  return [...names];
}

/** Every fixture identity (#243) a spec's steps authenticate as (`auth.identity`). */
export function identityNames(spec: FixtureSpec | undefined): string[] {
  const names = new Set<string>();
  for (const s of [...(spec?.setup ?? []), ...(spec?.restore ?? [])]) {
    if (s.auth !== undefined && s.auth.from !== "secretField" && s.auth.identity !== undefined) names.add(s.auth.identity);
  }
  return [...names];
}

function runHook(cmd: string, timeoutMs: number, stdin: string, env: Record<string, string>): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = clock.setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_HOOK_STDOUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_HOOK_STDOUT) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clock.clearTimeout(timer);
      resolve({ exitCode: null, timedOut, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (code) => {
      clock.clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

/**
 * One mission's fixture lifecycle. `setup()` before the mission, `restore()` after it (every exit
 * path), and `reset()` (restore the active state, then set up again) before each replay.
 */
export class MissionFixtures {
  readonly #opts: FixtureRunOptions;
  readonly #specHash: string;
  #values: Record<string, string> = {};
  #secretNames = new Set<string>();
  /** Restore-phase outputs (#560): live only for one restore pass, never exposed as setup bindings. */
  #restoreValues: Record<string, string> = {};
  #restoreSecretNames = new Set<string>();
  #active = false;
  #cycles = 0;
  readonly #log: FixtureStepLog[] = [];
  #restoreFailed = false;

  constructor(opts: FixtureRunOptions) {
    if (opts.hooks !== undefined && (opts.hooks.before !== undefined || opts.hooks.after !== undefined) && opts.allowShellHooks !== true) {
      throw new FixtureSpecError("--before/--after run operator shell commands: pass --allow-shell-hooks to opt in");
    }
    // #166: every `${secretField.VAR}` must name a binding this run has — refused here, before any
    // browser or request, like an unknown `${setup.x}`.
    const bound = opts.auth.secretFields ?? {};
    for (const [phase, steps] of [["setup", opts.spec?.setup ?? []], ["restore", opts.spec?.restore ?? []]] as const) {
      for (const [i, s] of steps.entries()) {
        for (const text of stringsIn([s.headers ?? {}, s.json ?? null, s.body ?? ""])) {
          for (const m of text.matchAll(SECRET_FIELD_REF)) {
            const v = bound[m[1] as string];
            if (v === undefined || v === "") {
              throw new FixtureSpecError(`fixtures.${phase}[${i}] references \${secretField.${m[1]}}, but the run has no --secret-field bound to env:${m[1]}`);
            }
          }
        }
      }
    }
    // #243: every `auth.identity` must be bound to a storageState file — refused here, before any
    // browser or request (never a silent fall back to the mission's own session).
    for (const name of identityNames(opts.spec)) {
      if (opts.auth.identities?.[name] === undefined) {
        throw new FixtureSpecError(
          `the fixture authenticates as identity ${name}, which is not bound: pass --fixture-identity ${name}=<storageState> or declare personas.${name}.storageState for this origin in targets.json`,
        );
      }
    }
    this.#opts = opts;
    this.#specHash = fixtureSpecHash(opts.spec, this.hookHashes());
  }

  hookHashes(): PersistedFixtures["hooks"] | undefined {
    const h = this.#opts.hooks;
    if (h?.before === undefined && h?.after === undefined) return undefined;
    return { ...(h.before === undefined ? {} : { before: hookHash(h.before) }), ...(h.after === undefined ? {} : { after: hookHash(h.after) }) };
  }

  get specHash(): string {
    return this.#specHash;
  }

  /** The output names the spec declares; `null` when a `--before` hook may bind more at run time. */
  declaredOutputs(): Set<string> | null {
    if (this.#opts.hooks?.before !== undefined) return null;
    return new Set((this.#opts.spec?.setup ?? []).flatMap((s) => Object.keys(s.outputs ?? {})));
  }

  /** The output names the spec declares secret. */
  declaredSecretOutputs(): Set<string> {
    return new Set((this.#opts.spec?.setup ?? []).flatMap((s) => s.secretOutputs ?? []));
  }

  bindings(): FixtureBindings {
    return { values: { ...this.#values }, secretNames: new Set(this.#secretNames) };
  }

  /** Non-secret outputs (what a replay's recorded values are rebound to). */
  publicOutputs(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.#values).filter(([k]) => !this.#secretNames.has(k)));
  }

  /** Secret output values (setup and the current restore pass): the caller adds them to the run's redaction set. */
  secrets(): string[] {
    const values = [...this.#secretNames].map((n) => this.#values[n]);
    values.push(...[...this.#restoreSecretNames].map((n) => this.#restoreValues[n]));
    // An output named like a credential is one, listed in secretOutputs or not (as an `extract` output is, #564).
    values.push(...Object.entries(this.#values).filter(([k]) => isSecretName(k)).map(([, v]) => v));
    values.push(...Object.entries(this.#restoreValues).filter(([k]) => isSecretName(k)).map(([, v]) => v));
    return [...new Set(values.filter((v): v is string => v !== undefined && v !== ""))];
  }

  /** The public outputs a result or artifact may hold: no credential-named value. */
  #reportedOutputs(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.publicOutputs()).filter(([k]) => !isSecretName(k)));
  }

  #redact(text: string): string {
    const bound = Object.values(this.#opts.auth.secretFields ?? {}).filter((v) => v !== "");
    return redactUrl(redactText(text, [...(this.#opts.secrets ?? []), ...bound, ...this.secrets()]));
  }

  identity(): string {
    return `fx-${sha256(canonical({ spec: this.#specHash, outputs: this.publicOutputs(), secret: [...this.#secretNames].sort() })).slice(0, 16)}`;
  }

  record(): FixtureRecord {
    return {
      identity: this.identity(),
      specHash: this.#specHash,
      outputs: this.#reportedOutputs(),
      secretOutputs: [...this.#secretNames].sort(),
      cycles: this.#cycles,
      log: [...this.#log],
    };
  }

  /** #243: the identities the spec's steps use → their storageState paths (paths only). */
  identities(): Record<string, string> | undefined {
    const names = identityNames(this.#opts.spec);
    if (names.length === 0) return undefined;
    return Object.fromEntries(names.sort().map((n) => [n, this.#opts.auth.identities?.[n] as string]));
  }

  persisted(): PersistedFixtures {
    const hooks = this.hookHashes();
    const identities = this.identities();
    return {
      identity: this.identity(),
      specHash: this.#specHash,
      ...(this.#opts.spec === undefined ? {} : { spec: this.#opts.spec }),
      ...(hooks === undefined ? {} : { hooks }),
      outputs: this.#reportedOutputs(),
      secretOutputs: [...this.#secretNames].sort(),
      ...(identities === undefined ? {} : { identities }),
    };
  }

  /** Sets up the fixture. Throws `FixtureSetupError`; the caller still calls `restore()`. */
  async setup(): Promise<void> {
    this.#values = {};
    this.#secretNames = new Set();
    this.#active = true;
    this.#cycles += 1;
    const before = this.#opts.hooks?.before;
    if (before !== undefined) await this.#runSetupHook(before);
    for (const [i, step] of (this.#opts.spec?.setup ?? []).entries()) {
      const failure = await this.#runHttp(step, "setup", i);
      if (failure !== null) throw new FixtureSetupError(failure);
    }
  }

  /** A restore step or the `--after` hook has failed. Sticky: what it left behind stays. */
  restoreFailed(): boolean {
    return this.#restoreFailed;
  }

  /** Restores the state the last `setup()` created. Never throws: every step is logged, and a failure shows in `restoreFailed()`. */
  async restore(): Promise<void> {
    // #560: each restore pass starts with no restore bindings, so `reset()` never reuses a stale id.
    this.#restoreValues = {};
    this.#restoreSecretNames = new Set();
    if (!this.#active) return;
    this.#active = false;
    for (const [i, step] of (this.#opts.spec?.restore ?? []).entries()) {
      if ((await this.#runHttp(step, "restore", i)) !== null) this.#restoreFailed = true;
    }
    const after = this.#opts.hooks?.after;
    if (after !== undefined) {
      const started = clock.now();
      const r = await runHook(after, this.#opts.hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, JSON.stringify({ vars: this.publicOutputs() }), {
        JEVITATE_FIXTURE_PHASE: "restore",
      });
      if (r.timedOut || r.exitCode !== 0) this.#restoreFailed = true;
      this.#log.push({
        phase: "restore",
        kind: "shell",
        name: "--after",
        ok: !r.timedOut && r.exitCode === 0,
        durationMs: clock.now() - started,
        exitCode: r.exitCode,
        ...(r.timedOut ? { detail: "timed out" } : {}),
        ...(r.stderr === "" ? {} : { stderr: clip(this.#redact(r.stderr)) }),
      });
    }
  }

  /** Before a replay: restore whatever is active, then set up afresh. Throws `FixtureSetupError`. */
  async reset(): Promise<void> {
    await this.restore();
    await this.setup();
  }

  async #runSetupHook(cmd: string): Promise<void> {
    const started = clock.now();
    const r = await runHook(cmd, this.#opts.hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, "", { JEVITATE_FIXTURE_PHASE: "setup" });
    let detail: string | undefined;
    if (r.timedOut) detail = "the --before hook timed out";
    else if (r.exitCode !== 0) detail = `the --before hook exited ${r.exitCode ?? "abnormally"}`;
    else detail = this.#bindHookStdout(r.stdout);
    this.#log.push({
      phase: "setup",
      kind: "shell",
      name: "--before",
      ok: detail === undefined,
      durationMs: clock.now() - started,
      exitCode: r.exitCode,
      ...(detail === undefined ? {} : { detail }),
      ...(r.stderr === "" ? {} : { stderr: clip(this.#redact(r.stderr)) }),
    });
    if (detail !== undefined) throw new FixtureSetupError(detail);
  }

  /** The `--before` stdout contract: empty, or one JSON object `{vars: {name: scalar}, secret?: [name]}`. */
  #bindHookStdout(stdout: string): string | undefined {
    const text = stdout.trim();
    if (text === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return "the --before hook printed something other than one JSON object {vars, secret}";
    }
    if (!isRecord(parsed) || (parsed.vars !== undefined && !isRecord(parsed.vars))) return "the --before hook's stdout must be {vars: {...}, secret?: [...]}";
    const secret = Array.isArray(parsed.secret) ? parsed.secret.filter((s): s is string => typeof s === "string") : [];
    for (const [name, v] of Object.entries((parsed.vars ?? {}) as Record<string, unknown>)) {
      if (!OUTPUT_NAME.test(name)) return `the --before hook var ${JSON.stringify(name)} is not an identifier`;
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return `the --before hook var ${name} is not a scalar`;
      this.#values[name] = String(v);
      if (secret.includes(name)) this.#secretNames.add(name);
    }
    return undefined;
  }

  /** Runs one HTTP step; returns the failure detail (redacted), or null. */
  async #runHttp(step: FixtureHttpStep, phase: "setup" | "restore", i: number): Promise<string | null> {
    const started = clock.now();
    const name = step.name ?? `${phase}[${i}]`;
    const log = (entry: Omit<FixtureStepLog, "phase" | "kind" | "name" | "durationMs" | "method">): void => {
      this.#log.push({ phase, kind: "http", name, method: step.method, durationMs: clock.now() - started, ...entry });
    };
    let url: string;
    let body: string | undefined;
    let headers: Record<string, string>;
    try {
      const b = this.bindings();
      const restoreB: FixtureBindings = { values: this.#restoreValues, secretNames: this.#restoreSecretNames };
      // Re-resolve and re-check the substituted URL (#560/#561): a bound value never widens the allowlist.
      url = assertStepUrl(substituteStepText(step.url, b, restoreB, phase, {}, name), this.#opts, name);
      const sub = (text: string): string => substituteStepText(text, b, restoreB, phase, this.#opts.auth.secretFields ?? {}, name);
      for (const [k, x] of Object.entries(step.headers ?? {})) {
        if (!CREDENTIAL_HEADERS.has(k.toLowerCase())) continue;
        // A `--before` hook may bind names at run time: a credential header still takes secret outputs only.
        for (const m of x.matchAll(OUTPUT_REF)) {
          const kind = m[1] as "setup" | "restore";
          const out = m[2] as string;
          if (kind === "setup" && !b.secretNames.has(out)) throw new UnboundSetupRefError(`${name}: headers.${k} uses \${setup.${out}}, which is not a secret output`);
          if (kind === "restore" && phase === "restore" && !restoreB.secretNames.has(out)) {
            throw new UnboundRestoreRefError(`${name}: headers.${k} uses \${restore.${out}}, which is not a secret output`);
          }
        }
      }
      headers = { ...(substituteDeep(step.headers ?? {}, sub) as Record<string, string>) };
      if (step.json !== undefined) {
        body = JSON.stringify(substituteDeep(step.json, sub));
        headers["content-type"] ??= "application/json";
      } else if (step.body !== undefined) {
        body = sub(step.body);
      }
      if (step.auth !== undefined) Object.assign(headers, authHeaders(step.auth, url, this.#opts.auth));
    } catch (e) {
      const detail = `${name}: ${this.#redact(firstLine(e))}`;
      log({ ok: false, url: this.#redact(step.url), detail });
      return detail;
    }
    const shownUrl = this.#redact(url);
    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    try {
      const res = await (this.#opts.fetchImpl ?? fetch)(url, {
        method: step.method,
        headers,
        ...(body === undefined ? {} : { body }),
        // Never follow a redirect: it could leave the allowlist.
        redirect: "manual",
        signal: controller.signal,
      });
      const accepted = step.expectStatus !== undefined ? step.expectStatus.includes(res.status) : res.status >= 200 && res.status < 300;
      if (!accepted) {
        const detail = `${name}: ${step.method} ${shownUrl} answered ${res.status}`;
        log({ ok: false, url: shownUrl, status: res.status, detail });
        return detail;
      }
      if (step.outputs !== undefined) {
        const text = await res.text();
        let doc: unknown;
        const needsJson = Object.values(step.outputs).some((p) => p.startsWith("$"));
        if (needsJson) {
          try {
            doc = JSON.parse(text);
          } catch {
            const detail = `${name}: the response is not JSON, so its outputs cannot be read`;
            log({ ok: false, url: shownUrl, status: res.status, detail });
            return detail;
          }
        }
        for (const [out, path] of Object.entries(step.outputs)) {
          const v = path.startsWith("header:") ? (res.headers.get(path.slice("header:".length)) ?? undefined) : selectJsonPath(doc, path);
          if (v === undefined || v === "") {
            const detail = `${name}: output ${out} (${path}) is missing from the response`;
            log({ ok: false, url: shownUrl, status: res.status, detail });
            return detail;
          }
          const values = phase === "restore" ? this.#restoreValues : this.#values;
          const secretNames = phase === "restore" ? this.#restoreSecretNames : this.#secretNames;
          values[out] = v;
          if (step.secretOutputs?.includes(out) === true) secretNames.add(out);
        }
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
      log({ ok: true, url: this.#redact(url), status: res.status });
      return null;
    } catch (e) {
      const detail = `${name}: ${step.method} ${shownUrl} failed: ${controller.signal.aborted ? "timed out" : this.#redact(firstLine(e))}`;
      log({ ok: false, url: shownUrl, detail });
      return detail;
    } finally {
      clock.clearTimeout(timer);
    }
  }
}

/**
 * A replay session re-uses the Recording of the ORIGINAL run, whose navigations carry the values
 * that run's setup bound (e.g. `/items/<old id>`). After a fresh setup, the same navigation must go
 * to the NEW value: this rewrites each recorded value to its current one in every `page.goto` of the
 * replay's own page (non-secret outputs of 4+ characters only — shorter ones are too ambiguous to
 * rewrite blindly).
 */
export function rebindReplayNavigation(
  page: { goto: (url: string, ...rest: never[]) => Promise<unknown> },
  recorded: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): void {
  const pairs = Object.entries(recorded)
    .map(([k, from]) => [from, current[k]] as const)
    .filter((p): p is readonly [string, string] => p[1] !== undefined && p[0] !== p[1] && p[0].length >= 4);
  if (pairs.length === 0) return;
  const original = page.goto.bind(page);
  page.goto = ((url: string, ...rest: never[]) => {
    let next = url;
    for (const [from, to] of pairs) {
      next = next.split(from).join(to).split(encodeURIComponent(from)).join(encodeURIComponent(to));
    }
    return original(next, ...rest);
  }) as typeof page.goto;
}

/** The fixture identity carried on a Recording (non-secret outputs only). */
export function recordingFixture(r: FixtureRecord): { identity: string; specHash: string; outputs: Record<string, string> } {
  return { identity: r.identity, specHash: r.specHash, outputs: { ...r.outputs } };
}


/** What a mission result carries: the record (log, identity, outputs) plus what a replay needs to restore the same state. */
export type MissionFixtureResult = FixtureRecord & Pick<PersistedFixtures, "spec" | "hooks" | "identities">;

/**
 * Wraps a replay-session opener (hang reproduction, `verify-fix`, regression capture) so EVERY
 * replay starts from the fixture's state: restore whatever is active, set up afresh (a failure
 * throws, so the replay is "could not open a session" — inconclusive, never evidence), then rebind
 * the Recording's values (`recorded`, from the run the Recording came from) to the new outputs.
 */
export function fixtureReplayOpener<S extends { readonly page: { goto: (url: string, ...rest: never[]) => Promise<unknown> } }>(
  open: () => Promise<S>,
  fx: MissionFixtures,
  recorded: Readonly<Record<string, string>>,
): () => Promise<S> {
  return async () => {
    await fx.reset();
    const session = await open();
    rebindReplayNavigation(session.page, recorded, fx.publicOutputs());
    return session;
  };
}
