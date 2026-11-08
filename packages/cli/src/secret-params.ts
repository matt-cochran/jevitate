import { FsJourneyStore, JourneyRegistry, declaredNonSecretParams, flatJourneySteps, isSecretName, journeyParamSchema, secretParamNames, type Journey } from "@jevitate/journey";
import { navigateUrlParams } from "@jevitate/recording";
import { SecretFieldSpecError, fieldMatches, parseSecretField, type Control, type SecretField } from "@jevitate/explore";
import type { TargetDescriptor } from "@jevitate/recording";
import { SETUP_REF, type MissionFixtures } from "./mission-fixtures.js";

/**
 * A secret parameter's value (declared `secret: true`, or a credential-like name) and the two
 * surfaces. Over MCP a Journey that needs one is refused by name. On the CLI it has a form that stays
 * off the command line: the `--secret-field` binding a goal run or `journey author` already takes,
 * or `targets.json`.
 */

/** The code of the refusal: a request carried a value for a secret parameter. */
export const SECRET_PARAM_OVER_MCP = "E_SECRET_PARAM_OVER_MCP";

const secretFieldHelp = "'<label|testId|id|name>=<value>=env:<VAR>'";

/** Names only, never a value. Says what to do instead. */
function refusalMessage(names: readonly string[]): string {
  return (
    `secret parameter${names.length === 1 ? "" : "s"} ${names.join(", ")}: a Journey that needs a secret doesn't run over MCP, because the value would pass through the model or be sent by a Journey an agent can promote; nothing ran. ` +
    `A person runs it on the CLI: jevitate journey run <id> --secret-field ${secretFieldHelp}. Or sign in once and use a stored session ('storageState'), so the Journey needs no secret. ` +
    `If the name only looks like a credential, declare the parameter "secret": false and have a person approve the Journey at a terminal (jevitate journey promote <id>): an approval over MCP lifts nothing, and a source's Journey can't lift it`
  );
}

/**
 * What makes a Journey secret-bound, by name and from the Journey alone, so before it runs: its secret
 * parameters and any step, `forEach` children included, that can extract a credential. Nothing
 * secret-bound goes to a model, so self-heal and annotate both decide with this.
 */
export function secretBoundNeeds(journey: Journey, params: Readonly<Record<string, string>>): string[] {
  const nonSecret = declaredNonSecretParams(journey);
  const extracted = flatJourneySteps(journey)
    .flatMap(({ recorded: { step } }) => (step.kind === "forEach" ? step.steps : [step]))
    .flatMap((step) => (step.kind === "extract" && isSecretName(step.as) && !nonSecret.has(step.as) ? [`extracted credential ${step.as}`] : []));
  return [...secretParamNames(journey, params).map((n) => `secret parameter ${n}`), ...new Set(extracted)];
}

/** A fixture's outputs that are secret, known once it is built: declared so, or named like a credential. */
export function fixtureSecretNeeds(fx: MissionFixtures | undefined): string[] {
  if (fx === undefined) return [];
  const named = [...(fx.declaredOutputs() ?? [])].filter((n) => isSecretName(n));
  return [...new Set([...fx.declaredSecretOutputs(), ...named])].map((n) => `fixture secret ${n}`);
}

/** The way out of a refusal for a name like `passengers`, which reads as a credential and isn't one. */
export const NOT_A_CREDENTIAL_WAY_OUT =
  'If a name here only looks like a credential (passengers, token_count), declare a parameter of that name "secret": false and have a person approve the Journey at a terminal (jevitate journey promote <id>): an approval over MCP lifts nothing';

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
  if (journey === null) return Object.keys(strings).filter(isSecretName);
  return secretParamNames(journey, strings).filter((n) => n in strings);
}

/**
 * Which of `params` are secret parameters with a value, for any of the Journeys `ids` names. Decided
 * Journey by Journey, so one Journey's `secret: false` never lifts another's refusal. `needed`: also
 * the secret parameters a Journey requires and the request leaves out, for a tool that would run it.
 */
export async function secretParamsCarried(dir: string, ids: readonly unknown[], params: unknown, opts: { readonly needed?: boolean } = {}): Promise<string[]> {
  const given = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  const journeys = await Promise.all(ids.filter((id) => typeof id === "string" && id !== "").map((id) => loadJourney(dir, id as string)));
  const carried = journeys.length === 0 ? secretParamsCarriedBy(null, given) : journeys.flatMap((j) => secretParamsCarriedBy(j, given));
  const needed = opts.needed !== true ? [] : journeys.flatMap((j) => (j === null ? [] : secretParamNames(j).filter((n) => journeyParamSchema(j).required.includes(n) && !(n in given))));
  return [...new Set([...carried, ...needed])].sort();
}

/** The warning for these secret parameters on the command line. It names them and never holds a value. */
export function secretParamNamesArgvWarning(names: readonly string[]): string {
  return (
    `warning: --param ${names.join(", ")}: a secret value on the command line is visible in the process list and shell history. ` +
    `\`jevitate journey run\` reads it from the environment instead: --secret-field ${secretFieldHelp}\n`
  );
}

/** The warning for secret parameters given with `--param`, or undefined. */
export function secretParamArgvWarning(journey: Journey, params: Readonly<Record<string, string>>): string | undefined {
  const names = secretParamsCarriedBy(journey, params);
  return names.length === 0 ? undefined : secretParamNamesArgvWarning(names);
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

/** A bound secret goes in at a field op on its origin, nowhere else: `navigate` and `http` send it without one. */
export class BoundSecretOutsideFieldError extends Error {
  readonly code = "E_SECRET_ORIGIN_REFUSED";
  constructor(name: string, where: string) {
    super(`secret parameter ${name} is bound, and ${where} would send it in a URL, where its origin can't be held to its binding; nothing ran. Take it out of ${where}, or give it with --param if that is what you mean`);
    this.name = "BoundSecretOutsideFieldError";
  }
}

function assertBoundOnlyInFields(journey: Journey, names: readonly string[]): void {
  for (const name of names) {
    for (const { recorded: { step } } of flatJourneySteps(journey)) {
      if (step.kind === "navigate" && navigateUrlParams(step.url).includes(name)) throw new BoundSecretOutsideFieldError(name, "a navigate step");
    }
    const ref = `\${${name}}`;
    for (const c of journey.metadata.endState ?? []) {
      if (c.kind === "http" && JSON.stringify(c).includes(ref)) throw new BoundSecretOutsideFieldError(name, "an http check");
    }
  }
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

/** Where a secret an operator's binding supplied may be typed: its origins, or the run's allowlist. */
export type BoundSecretParams = Readonly<Record<string, readonly string[] | "allowlist">>;

/** Two secret parameters and one binding, or one parameter and two bindings: which value goes where cannot be told. */
export class SecretFieldAmbiguousError extends Error {
  readonly code = "E_SECRET_FIELD_AMBIGUOUS";
  constructor(readonly params: readonly string[], descriptors: readonly string[]) {
    super(
      `secret parameter${params.length === 1 ? "" : "s"} ${params.join(", ")}: ${descriptors.join(", ")} cannot say which value goes to which field, so nothing ran. ` +
        `Bind each by a target only its own recorded step has (testId, id or name), or give all but one with --param on the CLI`,
    );
    this.name = "SecretFieldAmbiguousError";
  }
}

/**
 * The secret parameters the bindings supply, leaving out those already `given`: a binding matches
 * the recorded target of the step that types the parameter, the way it matched the live field when
 * the Journey was authored. A value is never guessed: an ambiguous match refuses.
 */
function paramsFromFields(journey: Journey, fields: readonly SecretField[], given: ReadonlySet<string> = new Set()): { params: Record<string, string>; used: Set<SecretField> } {
  const fieldsOf = new Map<string, Set<SecretField>>();
  const paramsOf = new Map<SecretField, Set<string>>();
  for (const { name, target } of secretParamTargets(journey)) {
    if (given.has(name)) continue;
    for (const field of fields.filter((f) => fieldMatchesTarget(f, target))) {
      fieldsOf.set(name, (fieldsOf.get(name) ?? new Set()).add(field));
      paramsOf.set(field, (paramsOf.get(field) ?? new Set()).add(name));
    }
  }
  const ambiguous = new Set<string>();
  for (const [name, bound] of fieldsOf) if (bound.size > 1) ambiguous.add(name);
  for (const names of paramsOf.values()) if (names.size > 1) for (const n of names) ambiguous.add(n);
  if (ambiguous.size > 0) {
    const descriptors = [...new Set([...ambiguous].flatMap((n) => [...(fieldsOf.get(n) ?? [])].map((f) => f.descriptor)))];
    throw new SecretFieldAmbiguousError([...ambiguous].sort(), descriptors);
  }
  const params: Record<string, string> = {};
  for (const [name, bound] of fieldsOf) params[name] = [...bound][0]!.secret;
  return { params, used: new Set(paramsOf.keys()) };
}

/**
 * `params` plus what `--secret-field` and the environment's `secretFields` (human-written, in
 * `targets.json`) supply; an explicit param wins, then a flag. A binding the operator typed that
 * supplies nothing is a mistake (`SecretFieldSpecError`, value-free); a target's spec that does not
 * resolve contributes nothing, and the parameter is reported missing as usual. An unknown Journey
 * keeps `params`, and the run reports it. `bound` says where each resolved value may be typed: a
 * target's on its own origin, a flag's on the run's allowlist.
 */
export async function withSecretParams(req: {
  readonly dir: string;
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
  readonly flags: readonly string[];
  readonly targetFields: readonly string[] | undefined;
  readonly targetOrigin: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<{ params: Record<string, string>; bound?: BoundSecretParams }> {
  if (req.flags.length === 0 && (req.targetFields ?? []).length === 0) return { params: { ...req.params } };
  const flagFields = [...new Set(req.flags)].map((spec) => replayField(spec, req.env));
  const journey = await loadJourney(req.dir, req.id);
  if (journey === null) return { params: { ...req.params } };
  const fromFlags = paramsFromFields(journey, flagFields, new Set(Object.keys(req.params)));
  const unused = flagFields.filter((f) => !fromFlags.used.has(f));
  if (unused.length > 0) {
    throw new SecretFieldSpecError(
      `--secret-field ${unused.map((f) => f.descriptor).join(", ")} matches no secret parameter of journey '${req.id}' that --param did not give (a recorded step's label, testId, id or name; type= needs a live field, so it cannot match on a replay)`,
    );
  }
  const targetFields = [...new Set(req.targetFields ?? [])].flatMap((spec) => {
    try {
      return [replayField(spec, req.env)];
    } catch (err) {
      if (err instanceof SecretFieldSpecError) return [];
      throw err;
    }
  });
  const fromTargets = paramsFromFields(journey, targetFields, new Set([...Object.keys(req.params), ...Object.keys(fromFlags.params)]));
  const bound: Record<string, readonly string[] | "allowlist"> = {};
  for (const name of Object.keys(fromFlags.params)) bound[name] = "allowlist";
  // Targets are keyed by origin, so there is one whenever a target's binding applied.
  for (const name of Object.keys(fromTargets.params)) bound[name] = req.targetOrigin === undefined ? [] : [req.targetOrigin];
  assertBoundOnlyInFields(journey, Object.keys(bound));
  return { params: { ...fromTargets.params, ...fromFlags.params, ...req.params }, ...(Object.keys(bound).length === 0 ? {} : { bound }) };
}
