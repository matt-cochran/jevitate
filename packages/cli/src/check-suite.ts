import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseViewport, resolveEmulation, type EmulationSpec } from "@jevitate/playwright";
import { validateDenyPatterns } from "@jevitate/explore";
import {
  SUITE_EXPLORE_OPTIONS,
  isSuiteExploreOption,
  type ExploreItemKind,
  type SuiteExploreOption,
  type SuiteExploreOptionName,
  type SuiteExploreOptions,
} from "./suite-explore-options.js";

/**
 * The `jevitate check --suite <file.json>` schema (#137). Validated in full BEFORE anything runs:
 * a typo'd field, a wrong type or an unknown strategy is a refusal naming the path, never a
 * silently skipped item. Relative file paths in the suite (invariants, storage state, journeys
 * dir, verify-fix results, fixture/upload files, actor/persona states) resolve against the suite
 * file's own directory.
 *
 * #195: goal and mission items take `jevitate explore`'s option set (`SUITE_EXPLORE_OPTIONS`, by
 * the flag's camelCase name: `deny`, `apiPrefix`, `logSource`, `stallTimeout`, `persona`, …). A
 * target sets them as defaults for every item they apply to; an item's own value replaces the
 * target's. An item may also set its own `storageState` (`null`: start without the target's
 * session, e.g. to drive a login), `secretFields`, and — goals — `fixtures`.
 *
 * ```json
 * {
 *   "version": 1,
 *   "name": "shop-ci",
 *   "budget": { "maxActions": 400, "maxMinutes": 20, "maxUsd": 2 },
 *   "ai": "real",
 *   "gateAdvisory": false,
 *   "targets": [{
 *     "name": "shop",
 *     "url": "https://staging.shop.example/",
 *     "allow": ["https://staging.shop.example"],
 *     "storageState": "auth.json",
 *     "secretFields": ["label=Password=env:SHOP_PASSWORD"],
 *     "fixtures": "fixtures/shop.json",
 *     "invariants": ["invariants/credits.json"],
 *     "journeys": ["login", { "id": "checkout", "params": { "sku": "A1" }, "routes": ["/cart/**"] }],
 *     "goals": [{ "name": "export", "goal": "export the report as CSV", "success": ["requestMade:GET /api/export"], "routes": ["/reports/**"] }],
 *     "viewport": "1280x800",
 *     "deny": ["/^Archive/i"], "apiPrefix": ["/api/"], "logSource": ["docker:shop-api"], "logDefect": ["error"],
 *     "missions": [
 *       { "strategy": "adversarial", "url": "https://staging.shop.example/settings", "maxActions": 60, "paid": ["/^Analyze/"] },
 *       { "strategy": "exploratory", "device": "iPhone 13" }
 *     ],
 *     "verifyFix": [{ "result": "baseline/adversarial-….result.json", "fingerprint": "3fa2…" }]
 *   }]
 * }
 * ```
 */

export type MissionStrategy = "coverage" | "exploratory" | "adversarial" | "feature" | "usability";
const STRATEGIES: readonly MissionStrategy[] = ["coverage", "exploratory", "adversarial", "feature", "usability"];

export interface SuiteBudget {
  /** Total executed browser actions across every item. */
  readonly maxActions?: number;
  /** Total wall-clock minutes. */
  readonly maxMinutes?: number;
  /** Total model spend (USD), as reported by the provider. */
  readonly maxUsd?: number;
}

export interface SuiteJourney {
  readonly id: string;
  /** `viewport` ("375x812") or `device` ("iPhone 13"); default: the target's. */
  readonly emulation?: EmulationSpec;
  readonly params: Readonly<Record<string, string>>;
  /** Route globs this Journey covers (for `--changed-routes`); default: its Recording's page routes. */
  readonly routes?: readonly string[];
  /** The item's own session (`null`: none, whatever the target's); default: the target's. */
  readonly storageState?: string | null;
}

/** What goal and mission items may set beyond their own fields (#195). */
export interface SuiteItemOverrides {
  /** The item's own session (`null`: start fresh, without the target's); default: the target's. */
  readonly storageState?: string | null;
  /** The item's own `secretFields` (replacing the target's). */
  readonly secretFields?: readonly string[];
  /** `explore`'s generic options, overriding the target's defaults. */
  readonly explore?: SuiteExploreOptions;
}

export interface SuiteGoal extends SuiteItemOverrides {
  readonly name: string;
  /** The item's own mission fixtures file (replacing the target's). */
  readonly fixtures?: string;
  /** `viewport` or `device`; default: the target's. */
  readonly emulation?: EmulationSpec;
  readonly goal: string;
  readonly success: readonly string[];
  readonly url?: string;
  readonly successWhen?: "final" | "held";
  readonly routes?: readonly string[];
  readonly maxActions?: number;
  readonly maxDecisions?: number;
}

export interface SuiteMission extends SuiteItemOverrides {
  readonly name: string;
  /** `viewport` or `device`; default: the target's. */
  readonly emulation?: EmulationSpec;
  readonly strategy: MissionStrategy;
  readonly url?: string;
  readonly routes?: readonly string[];
  /** `feature`: the capability name. */
  readonly feature?: string;
  /** `usability`: the job and app class. */
  readonly goal?: string;
  readonly appClass?: string;
  readonly maxActions?: number;
  readonly maxDecisions?: number;
}

export interface SuiteVerifyFix {
  readonly name: string;
  readonly result: string;
  readonly fingerprint: string;
  readonly replays?: number;
  /** The item's own session (`null`: none, whatever the target's); default: the target's. */
  readonly storageState?: string | null;
}

export interface SuiteTarget {
  readonly name: string;
  readonly url: string;
  /** The default `viewport` ("1280x800") or `device` ("iPhone 13") for every item of the target. */
  readonly emulation?: EmulationSpec;
  readonly allow: readonly string[];
  /** Applied to every item of the target — Journeys, goals, missions, verify-fix (#170). */
  readonly storageState?: string;
  /**
   * `--secret-field` specs (`label=Password=env:APP_PASSWORD`, #170): the value is read from the
   * environment when the check starts, never written in the suite. Typed by goal and usability
   * items; also what the target's fixtures may authenticate with.
   */
  readonly secretFields?: readonly string[];
  /** Mission fixtures file (#140/#144) run around each goal and Journey item; default: the targets.json one. */
  readonly fixtures?: string;
  readonly invariants: readonly string[];
  readonly journeysDir?: string;
  readonly journeys: readonly SuiteJourney[];
  readonly goals: readonly SuiteGoal[];
  readonly missions: readonly SuiteMission[];
  readonly verifyFix: readonly SuiteVerifyFix[];
  /** `explore`'s generic options: defaults for every goal and mission item they apply to (#195). */
  readonly explore?: SuiteExploreOptions;
}

export interface CheckSuite {
  readonly version: 1;
  readonly name: string;
  readonly budget: SuiteBudget;
  readonly ai?: "real" | "fake";
  /** Advisory findings (UX, 4xx-correlated console errors, Jev flags) fail the gate only when true. */
  readonly gateAdvisory: boolean;
  readonly targets: readonly SuiteTarget[];
  /** The suite file (absolute). */
  readonly path: string;
}

export class SuiteError extends Error {
  readonly code = "E_CHECK_SUITE" as const;
  constructor(message: string) {
    super(message);
    this.name = "SuiteError";
  }
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

class Reader {
  constructor(
    readonly source: string,
    readonly baseDir: string,
  ) {}

  fail(path: string, msg: string): never {
    throw new SuiteError(`${this.source}: ${path}: ${msg}`);
  }

  /** Refuses a field not in `own` (nor, with `explore`, one of `explore`'s options, #195). */
  keys(obj: Json, path: string, own: readonly string[], explore = false): void {
    for (const k of Object.keys(obj)) {
      if (own.includes(k) || (explore && isSuiteExploreOption(k))) continue;
      const camel = k.replace(/^-+/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (explore && camel !== k && (isSuiteExploreOption(camel) || own.includes(camel))) this.fail(`${path}.${k}`, `unknown field; did you mean ${JSON.stringify(camel)}?`);
      this.fail(`${path}.${k}`, `unknown field (allowed: ${own.join(", ")}${explore ? "; and explore's options by camelCase name, e.g. deny, apiPrefix, logSource" : ""})`);
    }
  }

  string(obj: Json, key: string, path: string): string;
  string(obj: Json, key: string, path: string, optional: true): string | undefined;
  string(obj: Json, key: string, path: string, optional?: true): string | undefined {
    const v = obj[key];
    if (v === undefined && optional === true) return undefined;
    if (typeof v !== "string" || v.trim() === "") this.fail(`${path}.${key}`, "must be a non-empty string");
    return v;
  }

  number(obj: Json, key: string, path: string, opts: { integer?: boolean } = {}): number | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (opts.integer === true && !Number.isInteger(v))) {
      this.fail(`${path}.${key}`, `must be a positive ${opts.integer === true ? "integer" : "number"}`);
    }
    return v;
  }

  strings(obj: Json, key: string, path: string): string[] {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.trim() !== "")) this.fail(`${path}.${key}`, "must be an array of non-empty strings");
    return v as string[];
  }

  list(obj: Json, key: string, path: string): unknown[] {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) this.fail(`${path}.${key}`, "must be an array");
    return v;
  }

  /** `viewport: "WxH"` or `device: "<Playwright device>"` (never both), validated now. */
  emulation(obj: Json, path: string): EmulationSpec | undefined {
    const viewport = this.string(obj, "viewport", path, true);
    const device = this.string(obj, "device", path, true);
    if (viewport === undefined && device === undefined) return undefined;
    let spec: EmulationSpec;
    try {
      spec = { ...(viewport === undefined ? {} : { viewport: parseViewport(viewport) }), ...(device === undefined ? {} : { device }) };
      resolveEmulation(spec);
    } catch (e) {
      return this.fail(path, e instanceof Error ? e.message : String(e));
    }
    return spec;
  }

  resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.baseDir, p);
  }

  url(obj: Json, key: string, path: string, optional?: true): string | undefined {
    const v = optional === true ? this.string(obj, key, path, true) : this.string(obj, key, path);
    if (v === undefined) return undefined;
    try {
      new URL(v);
    } catch {
      this.fail(`${path}.${key}`, `not a URL: ${JSON.stringify(v)}`);
    }
    return v;
  }
}

const emulationOf = (e: EmulationSpec | undefined): { emulation?: EmulationSpec } => (e === undefined ? {} : { emulation: e });

// ── explore options (#195) ───────────────────────────────────────────────────

const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NO_LITERAL = "a suite never carries a literal secret; the value is read from the environment when the check starts";

/**
 * Each suite level's own field names; targets, goals and missions also take every generic explore
 * option (`SUITE_EXPLORE_OPTIONS`).
 */
export const SUITE_FIELDS = {
  target: ["name", "url", "allow", "storageState", "secretFields", "fixtures", "invariants", "journeysDir", "journeys", "goals", "missions", "verifyFix", "viewport", "device"],
  journey: ["id", "params", "routes", "viewport", "device", "storageState"],
  goal: ["name", "goal", "success", "url", "successWhen", "routes", "maxActions", "maxDecisions", "viewport", "device", "storageState", "secretFields", "fixtures"],
  mission: ["name", "strategy", "url", "routes", "feature", "goal", "appClass", "maxActions", "maxDecisions", "viewport", "device", "storageState", "secretFields"],
  verifyFix: ["name", "result", "fingerprint", "replays", "storageState"],
} as const satisfies Record<string, readonly string[]>;

function envBindings(r: Reader, obj: Json, key: string, path: string): string[] {
  const list = r.strings(obj, key, path);
  list.forEach((b, i) => {
    const at = b.lastIndexOf("=env:");
    const head = at === -1 ? "" : b.slice(0, at);
    // The entry is never echoed: a value pasted in place of env:<VAR> must not reach a log.
    if (at === -1 || !ENV_VAR.test(b.slice(at + 5)) || head.indexOf("=") <= 0 || head.endsWith("=")) {
      r.fail(`${path}.${key}[${i}]`, `must be '<label|testId|type|id|name>=<value>=env:<VAR>'; ${NO_LITERAL}`);
    }
  });
  return list;
}

function readOption(r: Reader, obj: Json, key: SuiteExploreOptionName, path: string): unknown {
  const spec: SuiteExploreOption = SUITE_EXPLORE_OPTIONS[key];
  const at = `${path}.${key}`;
  const v = obj[key];
  switch (spec.shape) {
    case "string": {
      const s = r.string(obj, key, path);
      if (spec.oneOf !== undefined && !spec.oneOf.includes(s)) r.fail(at, `must be ${spec.oneOf.map((o) => JSON.stringify(o)).join(" | ")}`);
      return s;
    }
    case "path":
      return r.resolvePath(r.string(obj, key, path));
    case "boolean":
      if (typeof v !== "boolean") r.fail(at, "must be a boolean");
      return v;
    case "positive":
      return r.number(obj, key, path);
    case "integer": {
      const n = r.number(obj, key, path, { integer: true }) as number;
      if (spec.range !== undefined && (n < spec.range[0] || n > spec.range[1])) r.fail(at, `must be an integer in ${spec.range[0]}..${spec.range[1]}`);
      return n;
    }
    case "count":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) r.fail(at, "must be a non-negative integer");
      return v;
    case "ratio":
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) r.fail(at, "must be a number in 0..1");
      return v;
    case "strings": {
      const list = r.strings(obj, key, path);
      if (key === "deny" || key === "paid") {
        try {
          validateDenyPatterns(list, key);
        } catch (e) {
          r.fail(at, e instanceof Error ? e.message : String(e));
        }
      }
      return list;
    }
    case "named-paths":
      return r.strings(obj, key, path).map((e, i) => {
        const eq = e.indexOf("=");
        if (eq <= 0 || eq === e.length - 1) r.fail(`${at}[${i}]`, "must be '<name>=<storageState path>'");
        return `${e.slice(0, eq)}=${r.resolvePath(e.slice(eq + 1))}`;
      });
    case "env-refs":
      return r.strings(obj, key, path).map((e, i) => {
        if (!e.startsWith("env:") || !ENV_VAR.test(e.slice(4))) r.fail(`${at}[${i}]`, `must be an env:<VAR> reference; ${NO_LITERAL}`);
        return e;
      });
    case "env-bindings":
      return envBindings(r, obj, key, path);
  }
}

/**
 * The generic explore options set in `obj`. For an item (`kind` given) an option that does not
 * apply to it is refused, as `explore` refuses the flag; a target's are defaults for any kind.
 */
function exploreOptionsOf(r: Reader, obj: Json, path: string, kind?: ExploreItemKind): SuiteExploreOptions | undefined {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!isSuiteExploreOption(key)) continue;
    const applies: readonly ExploreItemKind[] = SUITE_EXPLORE_OPTIONS[key].appliesTo;
    if (kind !== undefined && !applies.includes(kind)) {
      r.fail(`${path}.${key}`, `does not apply to a ${kind === "goal" ? "goal" : `${kind} mission`} item (applies to: ${applies.join(", ")})`);
    }
    out[key] = readOption(r, obj, key, path);
  }
  const has = (k: string): boolean => out[k] !== undefined;
  if (kind !== undefined) {
    if ((has("actor") || has("persona") || has("personas")) && obj.storageState !== undefined) {
      r.fail(`${path}.storageState`, "cannot be combined with actor/persona/personas (each brings its own session)");
    }
    if (has("actor") && (has("persona") || has("personas"))) r.fail(`${path}.actor`, "cannot be combined with persona/personas");
    if ((has("persona") || has("personas")) && has("saveStorageState")) {
      r.fail(`${path}.saveStorageState`, "cannot be combined with persona/personas (one file cannot hold every persona)");
    }
  }
  return Object.keys(out).length === 0 ? undefined : (out as SuiteExploreOptions);
}

/** An item's `storageState`: a path (resolved), `null` (start without the target's session), or absent. */
function storageStateOf(r: Reader, obj: Json, path: string): { storageState?: string | null } {
  if (obj.storageState === null) return { storageState: null };
  const s = r.string(obj, "storageState", path, true);
  return s === undefined ? {} : { storageState: r.resolvePath(s) };
}

/** The goal/mission overrides: own session, own secret fields, explore options. */
function overridesOf(r: Reader, obj: Json, path: string, kind: ExploreItemKind): SuiteItemOverrides {
  const secretFields = envBindings(r, obj, "secretFields", path);
  if (secretFields.length > 0 && kind !== "goal" && kind !== "usability") r.fail(`${path}.secretFields`, "applies only to goal and usability items");
  const explore = exploreOptionsOf(r, obj, path, kind);
  return {
    ...storageStateOf(r, obj, path),
    ...(secretFields.length === 0 ? {} : { secretFields }),
    ...(explore === undefined ? {} : { explore }),
  };
}

function journeyOf(r: Reader, v: unknown, path: string): SuiteJourney {
  if (typeof v === "string" && v.trim() !== "") return { id: v, params: {} };
  if (!isRecord(v)) return r.fail(path, "must be a Journey id or { id, params?, routes? }");
  r.keys(v, path, SUITE_FIELDS.journey);
  const params = v.params ?? {};
  if (!isRecord(params) || !Object.values(params).every((p) => typeof p === "string")) r.fail(`${path}.params`, "must be an object of string values");
  const routes = r.strings(v, "routes", path);
  const emulation = r.emulation(v, path);
  return {
    id: r.string(v, "id", path),
    params: params as Record<string, string>,
    ...(routes.length === 0 ? {} : { routes }),
    ...(emulation === undefined ? {} : { emulation }),
    ...storageStateOf(r, v, path),
  };
}

function goalOf(r: Reader, v: unknown, path: string, i: number): SuiteGoal {
  if (!isRecord(v)) return r.fail(path, "must be an object");
  r.keys(v, path, SUITE_FIELDS.goal, true);
  const success = r.strings(v, "success", path);
  if (success.length === 0) r.fail(`${path}.success`, "at least one success check is required (a goal without one proves nothing)");
  const successWhen = v.successWhen;
  if (successWhen !== undefined && successWhen !== "final" && successWhen !== "held") r.fail(`${path}.successWhen`, 'must be "final" or "held"');
  const routes = r.strings(v, "routes", path);
  const url = r.url(v, "url", path, true);
  const maxActions = r.number(v, "maxActions", path, { integer: true });
  const maxDecisions = r.number(v, "maxDecisions", path, { integer: true });
  const fixtures = r.string(v, "fixtures", path, true);
  return {
    ...overridesOf(r, v, path, "goal"),
    ...(fixtures === undefined ? {} : { fixtures: r.resolvePath(fixtures) }),
    name: r.string(v, "name", path, true) ?? `goal-${i + 1}`,
    goal: r.string(v, "goal", path),
    ...emulationOf(r.emulation(v, path)),
    success,
    ...(url === undefined ? {} : { url }),
    ...(successWhen === undefined ? {} : { successWhen }),
    ...(routes.length === 0 ? {} : { routes }),
    ...(maxActions === undefined ? {} : { maxActions }),
    ...(maxDecisions === undefined ? {} : { maxDecisions }),
  };
}

function missionOf(r: Reader, v: unknown, path: string): SuiteMission {
  if (!isRecord(v)) return r.fail(path, "must be an object");
  r.keys(v, path, SUITE_FIELDS.mission, true);
  const strategy = r.string(v, "strategy", path);
  if (!STRATEGIES.includes(strategy as MissionStrategy)) r.fail(`${path}.strategy`, `must be one of ${STRATEGIES.join(" | ")}`);
  const s = strategy as MissionStrategy;
  const feature = r.string(v, "feature", path, true);
  if (s === "feature" && feature === undefined) r.fail(`${path}.feature`, "is required for strategy feature");
  const goal = r.string(v, "goal", path, true);
  const appClass = r.string(v, "appClass", path, true);
  if (s === "usability" && (goal === undefined || appClass === undefined)) r.fail(path, "strategy usability requires goal and appClass");
  const routes = r.strings(v, "routes", path);
  const url = r.url(v, "url", path, true);
  const maxActions = r.number(v, "maxActions", path, { integer: true });
  const maxDecisions = r.number(v, "maxDecisions", path, { integer: true });
  return {
    ...overridesOf(r, v, path, s),
    name: r.string(v, "name", path, true) ?? (feature === undefined ? s : `${s}-${feature}`),
    strategy: s,
    ...emulationOf(r.emulation(v, path)),
    ...(url === undefined ? {} : { url }),
    ...(routes.length === 0 ? {} : { routes }),
    ...(feature === undefined ? {} : { feature }),
    ...(goal === undefined ? {} : { goal }),
    ...(appClass === undefined ? {} : { appClass }),
    ...(maxActions === undefined ? {} : { maxActions }),
    ...(maxDecisions === undefined ? {} : { maxDecisions }),
  };
}

function verifyOf(r: Reader, v: unknown, path: string): SuiteVerifyFix {
  if (!isRecord(v)) return r.fail(path, "must be an object");
  r.keys(v, path, SUITE_FIELDS.verifyFix);
  const fingerprint = r.string(v, "fingerprint", path);
  const replays = r.number(v, "replays", path, { integer: true });
  return {
    name: r.string(v, "name", path, true) ?? `verify-${fingerprint}`,
    result: r.resolvePath(r.string(v, "result", path)),
    fingerprint,
    ...(replays === undefined ? {} : { replays }),
    ...storageStateOf(r, v, path),
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function targetOf(r: Reader, v: unknown, path: string): SuiteTarget {
  if (!isRecord(v)) return r.fail(path, "must be an object");
  r.keys(v, path, SUITE_FIELDS.target, true);
  const name = r.string(v, "name", path);
  if (!NAME.test(name)) r.fail(`${path}.name`, "must match [A-Za-z0-9][A-Za-z0-9._-]*");
  const url = r.url(v, "url", path) ?? r.fail(`${path}.url`, "is required");
  const storageState = r.string(v, "storageState", path, true);
  const secretFields = envBindings(r, v, "secretFields", path);
  const explore = exploreOptionsOf(r, v, path);
  const fixtures = r.string(v, "fixtures", path, true);
  const journeysDir = r.string(v, "journeysDir", path, true);
  const goals = r.list(v, "goals", path);
  return {
    name,
    url,
    ...emulationOf(r.emulation(v, path)),
    allow: r.strings(v, "allow", path),
    ...(storageState === undefined ? {} : { storageState: r.resolvePath(storageState) }),
    ...(secretFields.length === 0 ? {} : { secretFields }),
    ...(fixtures === undefined ? {} : { fixtures: r.resolvePath(fixtures) }),
    invariants: r.strings(v, "invariants", path).map((f) => r.resolvePath(f)),
    ...(journeysDir === undefined ? {} : { journeysDir: r.resolvePath(journeysDir) }),
    journeys: r.list(v, "journeys", path).map((j, i) => journeyOf(r, j, `${path}.journeys[${i}]`)),
    goals: goals.map((g, i) => goalOf(r, g, `${path}.goals[${i}]`, i)),
    missions: r.list(v, "missions", path).map((m, i) => missionOf(r, m, `${path}.missions[${i}]`)),
    verifyFix: r.list(v, "verifyFix", path).map((m, i) => verifyOf(r, m, `${path}.verifyFix[${i}]`)),
    ...(explore === undefined ? {} : { explore }),
  };
}

/** Validates a parsed suite. `file` names it in every refusal; relative paths resolve against it. */
export function parseSuite(raw: unknown, file: string): CheckSuite {
  const abs = resolve(file);
  const r = new Reader(file, dirname(abs));
  if (!isRecord(raw)) return r.fail("$", "must be a JSON object");
  r.keys(raw, "$", ["version", "name", "budget", "ai", "gateAdvisory", "targets"]);
  if (raw.version !== 1) r.fail("$.version", "must be 1");
  const budgetRaw = raw.budget ?? {};
  if (!isRecord(budgetRaw)) r.fail("$.budget", "must be an object");
  const b = budgetRaw as Json;
  r.keys(b, "$.budget", ["maxActions", "maxMinutes", "maxUsd"]);
  const maxActions = r.number(b, "maxActions", "$.budget", { integer: true });
  const maxMinutes = r.number(b, "maxMinutes", "$.budget");
  const maxUsd = r.number(b, "maxUsd", "$.budget");
  const ai: unknown = raw.ai;
  if (ai !== undefined && ai !== "real" && ai !== "fake") r.fail("$.ai", 'must be "real" or "fake"');
  if (raw.gateAdvisory !== undefined && typeof raw.gateAdvisory !== "boolean") r.fail("$.gateAdvisory", "must be a boolean");
  const targets = r.list(raw, "targets", "$").map((t, i) => targetOf(r, t, `$.targets[${i}]`));
  if (targets.length === 0) r.fail("$.targets", "at least one target is required");
  const names = new Set<string>();
  for (const t of targets) {
    if (names.has(t.name)) r.fail("$.targets", `duplicate target name ${JSON.stringify(t.name)}`);
    names.add(t.name);
  }
  return {
    version: 1,
    name: r.string(raw, "name", "$", true) ?? "suite",
    budget: {
      ...(maxActions === undefined ? {} : { maxActions }),
      ...(maxMinutes === undefined ? {} : { maxMinutes }),
      ...(maxUsd === undefined ? {} : { maxUsd }),
    },
    ...(ai === "real" || ai === "fake" ? { ai } : {}),
    gateAdvisory: raw.gateAdvisory === true,
    targets,
    path: abs,
  };
}

export function loadSuite(file: string): CheckSuite {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SuiteError(`cannot read suite ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseSuite(raw, file);
}
