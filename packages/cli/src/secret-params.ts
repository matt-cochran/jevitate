import { FsJourneyStore, JourneyRegistry, SECRET_PARAM_NAME_RE, flatJourneySteps, secretParamNames, type Journey } from "@jevitate/journey";
import { SecretFieldSpecError, fieldMatches, parseSecretField, type Control, type SecretField } from "@jevitate/explore";
import type { TargetDescriptor } from "@jevitate/recording";
import { SETUP_REF } from "./mission-fixtures.js";

/**
 * A secret parameter's value (declared `secret: true`, or a credential-like name) and the two
 * surfaces. Over MCP it would pass through the model, so a request's value is refused by name and
 * the value is only ever resolved by code from the operator's own `targets.json`. On the CLI it has
 * a form that stays off the command line: the `--secret-field` binding a goal run or
 * `journey author` already takes.
 */

/** The code of the refusal: a request carried a value for a secret parameter. */
export const SECRET_PARAM_OVER_MCP = "E_SECRET_PARAM_OVER_MCP";

const secretFieldHelp = "'<label|testId|id|name>=<value>=env:<VAR>'";

/** Names only, never a value. Says what to do instead. */
function refusalMessage(names: readonly string[]): string {
  return (
    `the value of secret parameter${names.length === 1 ? "" : "s"} ${names.join(", ")} cannot travel through an MCP request, because it would pass through the model; nothing ran. ` +
    `Ask the operator to bind the field in ~/.jevitate/targets.json under the environment's origin ("secretFields": ["label=<field>=env:<VAR>"]) and call run_journey with 'env' or 'baseUrl' and without this parameter, ` +
    `or to run it on the CLI: jevitate journey run <id> --secret-field ${secretFieldHelp}`
  );
}

/** The refusal `sources run` throws from inside the run gate, where the Journey is first known. */
export class SecretParamOverMcpError extends Error {
  readonly code = SECRET_PARAM_OVER_MCP;
  constructor(readonly params: readonly string[]) {
    super(refusalMessage(params));
    this.name = "SecretParamOverMcpError";
  }
}

/** The MCP error body for `names`. */
export function secretParamRefusalBody(names: readonly string[]): { error: "invalid_args"; code: string; params: readonly string[]; message: string } {
  return { error: "invalid_args", code: SECRET_PARAM_OVER_MCP, params: names, message: refusalMessage(names) };
}

/** Does this value hold something? A blank one or one made only of `${setup.x}` references (bound by a fixture, in code) does not. */
function holdsValue(value: unknown): boolean {
  return typeof value === "string" && value.replace(SETUP_REF, "").trim() !== "";
}

async function loadJourney(dir: string, id: string): Promise<Journey | null> {
  try {
    return await new JourneyRegistry(new FsJourneyStore(dir)).get(id);
  } catch {
    return null; // Corrupt or invalid: the command itself reports that.
  }
}

/** The secret parameters of `journey` (or by name alone, when there is no such Journey) that `params` gives a value for. */
export function secretParamsCarriedBy(journey: Journey | null, params: Readonly<Record<string, unknown>>): string[] {
  const strings = Object.fromEntries(Object.entries(params).filter(([, v]) => holdsValue(v))) as Record<string, string>;
  const secret = journey === null ? Object.keys(strings).filter((n) => SECRET_PARAM_NAME_RE.test(n)) : secretParamNames(journey, strings);
  return secret.filter((n) => n in strings);
}

/** Which of `params` are secret parameters with a value, for any of the Journeys `ids` names. */
export async function secretParamsCarried(dir: string, ids: readonly unknown[], params: unknown): Promise<string[]> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return [];
  const given = params as Record<string, unknown>;
  const names = new Set(secretParamsCarriedBy(null, given));
  for (const id of ids) {
    if (typeof id !== "string" || id === "") continue;
    for (const n of secretParamsCarriedBy(await loadJourney(dir, id), given)) names.add(n);
  }
  return [...names].sort();
}

/** The warning for secret parameters given with `--param`, or undefined. It names them and never holds a value. */
export function secretParamArgvWarning(journey: Journey, params: Readonly<Record<string, string>>): string | undefined {
  const names = secretParamsCarriedBy(journey, params);
  if (names.length === 0) return undefined;
  return (
    `warning: --param ${names.join(", ")}: a secret value on the command line is visible in the process list and shell history. ` +
    `\`jevitate journey run\` reads it from the environment instead: --secret-field ${secretFieldHelp}\n`
  );
}

/** `secretParamArgvWarning`, for a command that has only the Journey's id. */
export async function warnSecretParamsOnArgv(write: ((line: string) => void) | undefined, dir: string, ids: readonly (string | undefined)[], params: Readonly<Record<string, string>>): Promise<void> {
  if (Object.keys(params).length === 0) return;
  const lines = new Set<string>();
  for (const id of ids) {
    const journey = id === undefined ? null : await loadJourney(dir, id);
    const line = journey === null ? undefined : secretParamArgvWarning(journey, params);
    if (line !== undefined) lines.add(line);
  }
  for (const line of lines) write?.(line);
}

/** A replay's binding: `env:` only (a `cmd:` source is read at type time, which a replay's parameter is not). */
function replayField(spec: string, env: Readonly<Record<string, string | undefined>>): SecretField {
  if (spec.includes("=cmd:")) throw new SecretFieldSpecError(`--secret-field on a replay takes ${secretFieldHelp}: a cmd: source is for goal runs`);
  return parseSecretField(spec, "value", env);
}

/** `fieldMatches` on a recorded step's target. `type=` needs a live control, so it never matches here. */
function fieldMatchesTarget(field: SecretField, target: TargetDescriptor): boolean {
  return fieldMatches(field.matcher, { name: target.name ?? "", tag: "", descriptor: target } as unknown as Control);
}

/** Each secret parameter of `journey` a fill or select step types, with its step's target. */
function secretParamTargets(journey: Journey): Array<{ name: string; target: TargetDescriptor }> {
  const secret = new Set(secretParamNames(journey));
  return flatJourneySteps(journey).flatMap(({ recorded: { step } }) => {
    if ((step.kind !== "fill" && step.kind !== "select") || !("var" in step.value) || !secret.has(step.value.var)) return [];
    return [{ name: step.value.var, target: step.target }];
  });
}

/**
 * The secret parameters the bindings supply: a binding matches the recorded target of the step that
 * types the parameter, the way it matched the live field when the Journey was authored.
 */
function paramsFromFields(journey: Journey, fields: readonly SecretField[]): { params: Record<string, string>; used: Set<SecretField> } {
  const params: Record<string, string> = {};
  const used = new Set<SecretField>();
  for (const { name, target } of secretParamTargets(journey)) {
    const field = fields.find((f) => fieldMatchesTarget(f, target));
    if (field === undefined) continue;
    used.add(field);
    params[name] ??= field.secret;
  }
  return { params, used };
}

/**
 * `params` plus what `--secret-field` and the environment's `secretFields` (human-written, in
 * `targets.json`) supply; an explicit param wins, then a flag. A binding the operator typed that
 * supplies nothing is a mistake (`SecretFieldSpecError`, value-free); a target's spec that does not
 * resolve contributes nothing, and the parameter is reported missing as usual. An unknown Journey
 * keeps `params`, and the run reports it.
 */
export async function withSecretParams(req: {
  readonly dir: string;
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
  readonly flags: readonly string[];
  readonly targetFields: readonly string[] | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<Record<string, string>> {
  if (req.flags.length === 0 && (req.targetFields ?? []).length === 0) return { ...req.params };
  const flagFields = req.flags.map((spec) => replayField(spec, req.env));
  const journey = await loadJourney(req.dir, req.id);
  if (journey === null) return { ...req.params };
  const fromFlags = paramsFromFields(journey, flagFields);
  const unused = flagFields.filter((f) => !fromFlags.used.has(f));
  if (unused.length > 0) {
    throw new SecretFieldSpecError(
      `--secret-field ${unused.map((f) => f.descriptor).join(", ")} matches no secret parameter of journey '${req.id}' (a recorded step's label, testId, id or name; type= needs a live field, so it cannot match on a replay)`,
    );
  }
  const targetFields = (req.targetFields ?? []).flatMap((spec) => {
    try {
      return [replayField(spec, req.env)];
    } catch (err) {
      if (err instanceof SecretFieldSpecError) return [];
      throw err;
    }
  });
  return { ...paramsFromFields(journey, targetFields).params, ...fromFlags.params, ...req.params };
}
