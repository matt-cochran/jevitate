import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseViewport, resolveEmulation, type EmulationSpec } from "@jevitate/playwright";

/**
 * The `jevitate check --suite <file.json>` schema (#137). Validated in full BEFORE anything runs:
 * a typo'd field, a wrong type or an unknown strategy is a refusal naming the path, never a
 * silently skipped item. Relative file paths in the suite (invariants, storage state, journeys
 * dir, verify-fix results) resolve against the suite file's own directory.
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
 *     "missions": [
 *       { "strategy": "adversarial", "url": "https://staging.shop.example/settings", "maxActions": 60 },
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
}

export interface SuiteGoal {
  readonly name: string;
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

export interface SuiteMission {
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

  keys(obj: Json, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
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

function journeyOf(r: Reader, v: unknown, path: string): SuiteJourney {
  if (typeof v === "string" && v.trim() !== "") return { id: v, params: {} };
  if (!isRecord(v)) return r.fail(path, "must be a Journey id or { id, params?, routes? }");
  r.keys(v, path, ["id", "params", "routes", "viewport", "device"]);
  const params = v.params ?? {};
  if (!isRecord(params) || !Object.values(params).every((p) => typeof p === "string")) r.fail(`${path}.params`, "must be an object of string values");
  const routes = r.strings(v, "routes", path);
  const emulation = r.emulation(v, path);
  return {
    id: r.string(v, "id", path),
    params: params as Record<string, string>,
    ...(routes.length === 0 ? {} : { routes }),
    ...(emulation === undefined ? {} : { emulation }),
  };
}

function goalOf(r: Reader, v: unknown, path: string, i: number): SuiteGoal {
  if (!isRecord(v)) return r.fail(path, "must be an object");
  r.keys(v, path, ["name", "goal", "success", "url", "successWhen", "routes", "maxActions", "maxDecisions", "viewport", "device"]);
  const success = r.strings(v, "success", path);
  if (success.length === 0) r.fail(`${path}.success`, "at least one success check is required (a goal without one proves nothing)");
  const successWhen = v.successWhen;
  if (successWhen !== undefined && successWhen !== "final" && successWhen !== "held") r.fail(`${path}.successWhen`, 'must be "final" or "held"');
  const routes = r.strings(v, "routes", path);
  const url = r.url(v, "url", path, true);
  const maxActions = r.number(v, "maxActions", path, { integer: true });
  const maxDecisions = r.number(v, "maxDecisions", path, { integer: true });
  return {
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
  r.keys(v, path, ["name", "strategy", "url", "routes", "feature", "goal", "appClass", "maxActions", "maxDecisions", "viewport", "device"]);
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
  r.keys(v, path, ["name", "result", "fingerprint", "replays"]);
  const fingerprint = r.string(v, "fingerprint", path);
  const replays = r.number(v, "replays", path, { integer: true });
  return {
    name: r.string(v, "name", path, true) ?? `verify-${fingerprint}`,
    result: r.resolvePath(r.string(v, "result", path)),
    fingerprint,
    ...(replays === undefined ? {} : { replays }),
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function targetOf(r: Reader, v: unknown, path: string): SuiteTarget {
  if (!isRecord(v)) return r.fail(path, "must be an object");
  r.keys(v, path, ["name", "url", "allow", "storageState", "secretFields", "fixtures", "invariants", "journeysDir", "journeys", "goals", "missions", "verifyFix", "viewport", "device"]);
  const name = r.string(v, "name", path);
  if (!NAME.test(name)) r.fail(`${path}.name`, "must match [A-Za-z0-9][A-Za-z0-9._-]*");
  const url = r.url(v, "url", path) ?? r.fail(`${path}.url`, "is required");
  const storageState = r.string(v, "storageState", path, true);
  const secretFields = r.strings(v, "secretFields", path);
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
