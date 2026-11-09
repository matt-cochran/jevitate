import { AsyncLocalStorage } from "node:async_hooks";
import { FsJourneyStore, JourneyRegistry, declaredNonSecretParams, flatJourneySteps, isSecretName, journeyParamSchema, secretParamNames, type Journey } from "@jevitate/journey";
import { navigateUrlParams } from "@jevitate/recording";
import { SecretFieldSpecError, fieldMatches, parseSecretField, type Control, type SecretField } from "@jevitate/explore";
import type { TargetDescriptor } from "@jevitate/recording";
import { SETUP_REF, type MissionFixtures } from "./mission-fixtures.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";

/**
 * A secret parameter's value (declared `secret: true`, or a credential-like name) and the two
 * surfaces. Over MCP a Journey that needs one is refused by name. On the CLI it has a form that stays
 * off the command line: the `--secret-field` binding a goal run or `journey author` already takes,
 * or `targets.json`.
 */

/** The code of the refusal: a request carried a value for a secret parameter. */
export const SECRET_PARAM_OVER_MCP = "E_SECRET_PARAM_OVER_MCP";

const secretFieldHelp = "'<label|testId|id|name>=<value>=env:<VAR>'";
/** #819: the binding that works for any secret parameter, one in a `navigate` URL included. */
const secretParamHelp = (name: string): string => `'param=${name}=env:<VAR>'`;

/** Names only, never a value. Says what to do instead. */
function refusalMessage(names: readonly string[]): string {
  return (
    `secret parameter${names.length === 1 ? "" : "s"} ${names.join(", ")}: a Journey that needs a secret doesn't run over MCP, because the value would pass through the model or be sent by a Journey an agent can promote; nothing ran. ` +
    `A person runs it on the CLI: jevitate journey run <id> --secret-field ${secretFieldHelp} (a field) or --secret-field ${secretParamHelp("<name>")} (any secret parameter, a token in a navigate URL included). Or sign in once and use a stored session ('storageState'), so the Journey needs no secret. ` +
    `If the name only looks like a credential, declare the parameter "secret": false and have a person approve the Journey at a terminal (jevitate journey promote <id>): an approval over MCP lifts nothing, and a source's Journey can't lift it`
  );
}

/**
 * Extract naming (0.30.0): terms that are a credential wherever they appear in an `extract as` name,
 * separators ignored. None of them occurs inside an ordinary English word.
 */
const EXTRACT_CREDENTIAL_ANYWHERE_RE =
  /passw|pwd|ssword|p4ss|passphrase|passcode|s3cret|t0ken|credential|bearer|jwt|csrf|xsrf|hmac|sessid|saml|twofactor|apikey|privatekey|accesskey|secretkey|sshkey|signingkey|encryptionkey|sharedkey|licensekey|pincode|pinnumber|smscode|verificationcode|recoverycode|backupcode|invitecode|securitycode|securityanswer|cardnumber|ccnumber|creditcard|webhookurl|connectionstring|magiclink|resetlink|kennwort|wachtwoord|contrase|senha|пароль|密码|暗号|パスワード/;

/** Terms that are a credential as a word of the name, or at the start or end of one (`authToken`, `sessionid`, `csrftoken`). */
const EXTRACT_CREDENTIAL_EDGE_TERMS = ["secret", "token", "session", "cookie", "otp", "auth", "mfa", "2fa", "cvv", "cvc", "nonce", "signature", "assertion", "iban", "dsn", "clave", "parola"] as const;

/** Terms that are a credential only as a whole word of the name (`pass` but not `passengers`, `pin` but not `spin`). */
const EXTRACT_CREDENTIAL_WORD_RE = /^(?:pass|pins?|pw|sess|sid|ssn|creds?|key|tfa|mdp)\d*$/;

/** A last word that says the name is ABOUT a credential, not one: `token_count`, `session_name`, `cookie_banner`. */
const DESCRIBING_LAST_WORDS: ReadonlySet<string> = new Set(["count", "total", "type", "kind", "length", "len", "name", "label", "title", "channel", "banner", "enabled", "required", "expiry", "expires", "ttl"]);

/** The words of a name: separators and camelCase boundaries split it, lower-cased (`authToken` → auth, token). */
function nameWords(name: string): string[] {
  return name
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1_$2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1_$2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

function edgeTermIn(word: string): boolean {
  return EXTRACT_CREDENTIAL_EDGE_TERMS.some((t) => {
    if (word !== t && !word.startsWith(t) && !word.endsWith(t)) return false;
    // `author` and `authority` are not `auth`; `authorization` and `authorize` are.
    if (t === "auth" && word.startsWith("author") && !word.startsWith("authoriz") && !word.endsWith("auth")) return false;
    return true;
  });
}

/**
 * Extract naming (0.29.0 accepted limit, narrowed in 0.30.0): is an `extract as` name a credential's?
 * Such an extract makes the Journey secret-bound, so it loses self-heal and annotate, and its value is
 * masked as it binds. Narrower than {@link isSecretName}, and never wider: a name matches only if
 * `isSecretName` does too and, by its words (separators and camelCase split it):
 *  - the name, separators removed, holds an unambiguous credential term (`password`, `pwd`, `apikey`,
 *    `jwt`, `csrf`, `pincode`, …), or
 *  - a word is, starts with or ends with `secret`, `token`, `session`, `cookie`, `otp`, `auth` (not
 *    `author`), `mfa`, `2fa`, `cvv`, `cvc`, `nonce`, `signature`, `assertion`, `iban`, `dsn`, or
 *  - a word is exactly `pass`, `pin`, `pins`, `pw`, `sess`, `sid`, `ssn`, `cred`, `creds`, `key`, `tfa`
 *    or `mdp` (a trailing number allowed: `pin2`);
 *  - unless the name has two or more words and its last one describes rather than holds a value
 *    (`count`, `total`, `type`, `kind`, `length`, `len`, `name`, `label`, `title`, `channel`, `banner`,
 *    `enabled`, `required`, `expiry`, `expires`, `ttl`).
 * So `apiKey`, `authToken`, `session_id`, `user_pass` and `otp` refuse; `passengers`, `footprint`,
 * `bypass_cache`, `token_count` and `cookie_banner` don't. A parameter's name still uses the broad rule
 * (it has its way out: `secret: false` with a person's approval).
 */
export function isCredentialExtractName(name: string): boolean {
  const words = nameWords(name);
  const last = words[words.length - 1];
  if (words.length >= 2 && last !== undefined && DESCRIBING_LAST_WORDS.has(last)) return false;
  return extractNameMentionsCredential(name);
}

/**
 * `isCredentialExtractName` without the describing-last-word exemption: the name holds a credential
 * term (`apiKey_name`, `token_count` as much as `apiKey`). A run masks such an extract's value as it
 * binds when the value is long enough to be a credential (`MASKED_DESCRIBED_EXTRACT_LENGTH`), even
 * though the name alone does not make the Journey secret-bound: see `masksExtractedValue`.
 */
export function extractNameMentionsCredential(name: string): boolean {
  if (!isSecretName(name)) return false;
  const words = nameWords(name);
  if (EXTRACT_CREDENTIAL_ANYWHERE_RE.test(words.join(""))) return true;
  return words.some((w) => edgeTermIn(w) || EXTRACT_CREDENTIAL_WORD_RE.test(w));
}

/** From this length a value is long enough to be a credential (the guard's plain-substring length, credential-guard.ts). */
const MASKED_DESCRIBED_EXTRACT_LENGTH = 6;

/**
 * Does a run mask the value an `extract as <name>` binds (pixel mask, redaction set, the heal payload)?
 * A credential name always; a name that mentions one but ends in a describing word (`apiKey_name`,
 * `session_label`) when its value is credential-length, so a real key behind a describing name is still
 * masked while `token_count = 42` does not mask every 42 in the evidence. `nonSecret`: declared `secret: false`.
 */
export function masksExtractedValue(name: string, value: string, nonSecret: ReadonlySet<string>): boolean {
  if (nonSecret.has(name) || value.trim() === "") return false;
  if (isCredentialExtractName(name)) return true;
  return extractNameMentionsCredential(name) && value.trim().length >= MASKED_DESCRIBED_EXTRACT_LENGTH;
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
    .flatMap((step) => (step.kind === "extract" && isCredentialExtractName(step.as) && !nonSecret.has(step.as) ? [`extracted credential ${step.as}`] : []));
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

/** The secret parameters `journey` requires that `params` leaves out (a value nobody supplied yet). Names only. */
export function missingSecretParams(journey: Journey, params: Readonly<Record<string, string>>): string[] {
  const required = journeyParamSchema(journey).required;
  return secretParamNames(journey).filter((n) => required.includes(n) && !(n in params)).sort();
}

/**
 * The warning for these secret parameters on the command line. It names them and never holds a value.
 * #819: the route it names works for every secret parameter, a token in a `navigate` URL included
 * (`param=<name>`); a field binding works only for one a field types. `command`: the command that
 * takes `--secret-field` (#827); undefined: one that has none, so the warning says which does.
 */
export function secretParamNamesArgvWarning(names: readonly string[], command?: string): string {
  const bindings = names.map((n) => `--secret-field ${secretParamHelp(n)}`).join(" ");
  const where = command === undefined ? "`jevitate journey run` reads it from the environment instead" : `\`jevitate ${command}\` reads it from the environment instead`;
  return (
    `warning: --param ${names.join(", ")}: a secret value on the command line is visible in the process list and shell history. ` +
    `${where}: ${bindings} (any secret parameter, a token in a navigate URL included), or a field's binding ${secretFieldHelp}; with --env or --base-url, that origin's targets.json secretFields take the same bindings\n`
  );
}

/** The warning for secret parameters given with `--param`, or undefined. */
export function secretParamArgvWarning(journey: Journey, params: Readonly<Record<string, string>>, command?: string): string | undefined {
  const names = secretParamsCarriedBy(journey, params);
  return names.length === 0 ? undefined : secretParamNamesArgvWarning(names, command);
}

/** `secretParamArgvWarning`, for a command that has only the Journey's id. `command`: as in {@link secretParamNamesArgvWarning}. */
export async function warnSecretParamsOnArgv(write: ((line: string) => void) | undefined, dir: string, ids: readonly (string | undefined)[], params: Readonly<Record<string, string>>, command?: string): Promise<void> {
  if (Object.keys(params).length === 0) return;
  const lines = new Set<string>();
  for (const id of ids) {
    const journey = id === undefined ? null : await loadJourney(dir, id);
    const line = journey === null ? undefined : secretParamArgvWarning(journey, params, command);
    if (line !== undefined) lines.add(line);
  }
  for (const line of lines) write?.(line);
}

/**
 * A bound secret goes only to its binding's origin: typed into a field there, or (#819) sent in a
 * `navigate` URL whose origin is one of them. An `http` check sends it outside the browser, where its
 * origin can't be held to the binding, so that is refused.
 */
export class BoundSecretOutsideFieldError extends Error {
  readonly code = "E_SECRET_ORIGIN_REFUSED";
  constructor(name: string, where: string, why = "would send it in a URL, where its origin can't be held to its binding") {
    super(`secret parameter ${name} is bound, and ${where} ${why}; nothing ran. Take it out of ${where}, or give it with --param if that is what you mean`);
    this.name = "BoundSecretOutsideFieldError";
  }
}

/** The origin a navigate template goes to when its origin is literal (`https://host/…${x}`); undefined for a relative one (the page's own). */
function literalNavigateOrigin(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    return new URL(url.replace(/\$\{[^}]*\}/g, "x")).origin;
  } catch {
    return undefined;
  }
}

/**
 * Before anything runs: a bound secret in an `http` check refuses; one in a navigate URL whose literal
 * origin is not its binding's refuses. A relative navigate URL goes to the page's own origin, which the
 * replay checks as it navigates (the interpreter, `boundSecretParams`), as it does for a field.
 * `targetOrigin`: where the run goes, which the Journey's recorded site stands for.
 */
function assertBoundOnlyOnOrigin(journey: Journey, bound: BoundSecretParams, targetOrigin: string | undefined): void {
  const site = literalNavigateOrigin(journey.recording.site);
  for (const [name, origins] of Object.entries(bound)) {
    for (const { recorded: { step } } of flatJourneySteps(journey)) {
      if (step.kind !== "navigate" || !navigateUrlParams(step.url).includes(name) || origins === "allowlist") continue;
      const literal = literalNavigateOrigin(step.url);
      const goesTo = literal !== undefined && literal === site && targetOrigin !== undefined ? targetOrigin : literal;
      if (goesTo !== undefined && !origins.includes(goesTo)) throw new BoundSecretOutsideFieldError(name, "a navigate step", `would send it to ${goesTo}, and its binding is for ${origins.join(", ") || "no origin"}`);
    }
    const ref = `\${${name}}`;
    for (const c of journey.metadata.endState ?? []) {
      if (c.kind === "http" && JSON.stringify(c).includes(ref)) throw new BoundSecretOutsideFieldError(name, "an http check");
    }
  }
}

/** A replay's binding: `env:` only (a `cmd:` source is read at type time, which a replay's parameter is not). `param=<name>` binds a parameter by name (#819). */
function replayField(spec: string, env: Readonly<Record<string, string | undefined>>): SecretField {
  if (spec.includes("=cmd:")) throw new SecretFieldSpecError(`--secret-field on a replay takes ${secretFieldHelp}: a cmd: source is for goal runs`);
  return parseSecretField(spec, "value", env);
}

/** `fieldMatches` on a recorded step's target. `type=` needs a live control, so it never matches here. */
export function fieldMatchesTarget(field: SecretField, target: TargetDescriptor): boolean {
  return fieldMatches(field.matcher, { name: target.name ?? "", tag: "", descriptor: target } as unknown as Control);
}

/** Each secret parameter of `journey` a fill or select step types, with its step's target. */
export function secretParamTargets(journey: Journey): Array<{ name: string; target: TargetDescriptor }> {
  const secret = new Set(secretParamNames(journey));
  return flatJourneySteps(journey).flatMap(({ recorded: { step } }) => {
    if ((step.kind !== "fill" && step.kind !== "select") || !("var" in step.value) || !secret.has(step.value.var)) return [];
    return [{ name: step.value.var, target: step.target }];
  });
}

/**
 * Where a secret an operator's binding supplied may be typed: its origins, or `"allowlist"` (a
 * `--secret-field`'s), which the run resolves to the origins a person or operator named for it
 * (`operatorAllowedOrigins`: the environment's, the run's own, `--allow`), never the Journey's authored ones.
 */
export type BoundSecretParams = Readonly<Record<string, readonly string[] | "allowlist">>;

/** `bound` with each `"allowlist"` binding resolved to `operatorOrigins`; undefined when nothing is bound. */
export function resolveBoundSecretOrigins(bound: BoundSecretParams | undefined, operatorOrigins: readonly string[]): Record<string, readonly string[]> | undefined {
  if (bound === undefined) return undefined;
  return Object.fromEntries(Object.entries(bound).map(([n, o]) => [n, o === "allowlist" ? [...operatorOrigins] : o] as const));
}

/**
 * The run's pre-check, once every binding is resolved to origins (`resolveBoundSecretOrigins`), a
 * `--secret-field`'s included: a navigate URL that would carry a bound secret to another origin, or an
 * http check that would send it, refuses (`BoundSecretOutsideFieldError`) before any browser opens.
 */
export function assertBoundSecretsOnOrigins(journey: Journey, bound: Readonly<Record<string, readonly string[]>>, targetOrigin: string | undefined): void {
  assertBoundOnlyOnOrigin(journey, bound, targetOrigin);
}

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
  const bind = (name: string, field: SecretField): void => {
    fieldsOf.set(name, (fieldsOf.get(name) ?? new Set()).add(field));
    paramsOf.set(field, (paramsOf.get(field) ?? new Set()).add(name));
  };
  for (const { name, target } of secretParamTargets(journey)) {
    if (given.has(name)) continue;
    for (const field of fields.filter((f) => fieldMatchesTarget(f, target))) bind(name, field);
  }
  // #819: `param=<name>` binds a secret parameter by its name, wherever the Journey uses it (a navigate URL too).
  for (const name of secretParamNames(journey)) {
    if (given.has(name)) continue;
    for (const field of fields.filter((f) => f.matcher.key === "param" && f.matcher.value === name)) bind(name, field);
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
  const journey = await loadJourney(req.dir, req.id);
  if (journey === null) {
    // Still a mistake the operator typed, whatever the Journey.
    for (const spec of new Set(req.flags)) replayField(spec, req.env);
    return { params: { ...req.params } };
  }
  return withSecretParamsFor(journey, req);
}

/** `withSecretParams` on a Journey already read (the run reads it once). */
export function withSecretParamsFor(
  journey: Journey,
  req: {
    readonly id: string;
    readonly params: Readonly<Record<string, string>>;
    readonly flags: readonly string[];
    readonly targetFields: readonly string[] | undefined;
    readonly targetOrigin: string | undefined;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): { params: Record<string, string>; bound?: BoundSecretParams } {
  if (req.flags.length === 0 && (req.targetFields ?? []).length === 0) return { params: { ...req.params } };
  const flagFields = [...new Set(req.flags)].map((spec) => replayField(spec, req.env));
  const fromFlags = paramsFromFields(journey, flagFields, new Set(Object.keys(req.params)));
  const unused = flagFields.filter((f) => !fromFlags.used.has(f));
  if (unused.length > 0) {
    throw new SecretFieldSpecError(
      `--secret-field ${unused.map((f) => f.descriptor).join(", ")} matches no secret parameter of journey '${req.id}' that --param did not give (a recorded step's label, testId, id or name, or param=<name>; type= needs a live field, so it cannot match on a replay)`,
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
  assertBoundOnlyOnOrigin(journey, bound, req.targetOrigin);
  return { params: { ...fromTargets.params, ...fromFlags.params, ...req.params }, ...(Object.keys(bound).length === 0 ? {} : { bound }) };
}

/**
 * #827: the bound secrets of the replays a command makes, where a surface's own plumbing does not carry
 * them (verify, chain, demo, an exploration's prefix): each replay in `fn` types or sends them on their
 * binding's origin only, as `journey run --secret-field` does.
 */
const boundScope = new AsyncLocalStorage<BoundSecretParams>();

export function withBoundSecretParams<T>(bound: BoundSecretParams | undefined, fn: () => Promise<T>): Promise<T> {
  return bound === undefined ? fn() : boundScope.run(bound, fn);
}

/** The bound secrets of the command this replay is part of, if it bound any. */
export function currentBoundSecretParams(): BoundSecretParams | undefined {
  return boundScope.getStore();
}

/**
 * #827: `withSecretParams` for a command that replays one or more Journeys (`journey verify`, `journey
 * chain --from --to`, `journey demo`, `load run`, `source run`, `explore --from-journey`): `--secret-field`
 * and, with `--env`/`--base-url`, the environment's `targets.json` `secretFields` supply each Journey's
 * secret parameters from the environment, off the command line. A flag must bind a secret parameter of at
 * least one of the Journeys; one Journey's binding never lifts another's refusal. Unknown Journeys keep
 * `params` (the command reports them).
 */
export async function withCommandSecretParams(req: {
  readonly dir: string;
  readonly ids: readonly (string | undefined)[];
  readonly params: Readonly<Record<string, string>>;
  readonly flags: readonly string[];
  readonly environment?: ResolvedJourneyEnvironment | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** false: a flag that binds none of the Journeys is left for the caller (`explore`'s goal loop binds live fields). */
  readonly strict?: boolean;
  /** Where the target's trust is read (`environmentSeams`): the defaults otherwise. */
  readonly seams?: { readonly environmentsFile?: string | undefined; readonly targetsFile?: string | undefined } | undefined;
}): Promise<{ params: Record<string, string>; bound?: BoundSecretParams; used: readonly string[] }> {
  const targetFields = req.environment?.secretFields;
  if (req.flags.length === 0 && (targetFields ?? []).length === 0) return { params: { ...req.params }, used: [] };
  // Loaded late, as below: approval-provenance reaches this module through the CLI's shared modules.
  const mcp = (await import("./approval-provenance.js")).inMcpInvocation();
  const ids = [...new Set(req.ids.filter((id): id is string => typeof id === "string" && id !== ""))];
  const journeys = (await Promise.all(ids.map(async (id) => [id, await loadJourney(req.dir, id)] as const))).filter((e): e is readonly [string, Journey] => e[1] !== null);
  const specs = [...new Set(req.flags)];
  // A mistake the operator typed, whatever the Journeys: a malformed spec, an unset variable.
  const parsed = specs.map((spec) => replayField(spec, req.env));
  let params: Record<string, string> = { ...req.params };
  const bound: Record<string, readonly string[] | "allowlist"> = {};
  const used = new Set<string>();
  for (const [id, journey] of journeys) {
    // Only the flags that bind something of this Journey: the others are another Journey's.
    const mine = specs.filter((_, i) => paramsFromFields(journey, [parsed[i]!], new Set(Object.keys(req.params))).used.size > 0);
    for (const spec of mine) used.add(spec);
    // 0.30.0 §5.3: over MCP the operator's targets.json binding serves only a Journey the run-mode rules let read it.
    const fields = mcp && !(await mcpMayReadTargetSecrets(journey, req.environment, req.seams)) ? undefined : targetFields;
    const r = withSecretParamsFor(journey, { id, params: req.params, flags: mine, targetFields: fields, targetOrigin: req.environment?.baseUrl, env: req.env });
    params = { ...r.params, ...params };
    Object.assign(bound, r.bound ?? {});
  }
  const unused = specs.filter((s) => !used.has(s));
  if (unused.length > 0 && journeys.length > 0 && req.strict !== false) {
    throw new SecretFieldSpecError(
      `--secret-field ${unused.map((s) => parsed[specs.indexOf(s)]!.descriptor).join(", ")} matches no secret parameter of journey ${journeys.map(([id]) => `'${id}'`).join(" or ")} that --param did not give (a recorded step's label, testId, id or name, or param=<name>; type= needs a live field, so it cannot match on a replay)`,
    );
  }
  return { params, ...(Object.keys(bound).length === 0 ? {} : { bound }), used: [...used] };
}

/**
 * 0.30.0 §5.3, the rule `planSecretRun` and `testModeSecrets` apply (journey-secret-mode.ts), here for a
 * command's own binding step: over MCP a Journey reads the operator's `targets.json` `secretFields` only
 * when it is promoted and, on an automation-mode target, carries an approval a person made (owner
 * decision 5); on a test-mode target any promotion will do (decision 5: an MCP promotion authorises
 * test-mode runs). A draft never does. What this leaves out is the run's secret mode's to meet (a hold,
 * or a refusal), never a value the agent chose where to send.
 */
async function mcpMayReadTargetSecrets(
  journey: Journey,
  environment: ResolvedJourneyEnvironment | undefined,
  seams: { readonly environmentsFile?: string | undefined; readonly targetsFile?: string | undefined } | undefined,
): Promise<boolean> {
  if (journey.metadata.promoted !== true) return false;
  // Loaded late: the run-mode gate reaches this module through the CLI's shared modules.
  const { approvalAuthorisesAutomation, resolveRunTarget } = await import("./journey-run-mode-gate.js");
  const target = resolveRunTarget({
    origin: environment?.baseUrl ?? journey.recording.site,
    environment,
    ...(seams?.environmentsFile === undefined ? {} : { environmentsFile: seams.environmentsFile }),
    ...(seams?.targetsFile === undefined ? {} : { targetsFile: seams.targetsFile }),
  });
  return target.mode === "test" || approvalAuthorisesAutomation(journey);
}

/** `--secret-field` on a replay command (#819, #827): the same binding `journey run` takes. */
export const REPLAY_SECRET_FIELD_HELP =
  "a secret parameter from the environment, off the command line (repeatable): '<label|testId|id|name>=<value>=env:<VAR>' matched on the recorded step that types it, e.g. 'label=Password=env:APP_PASSWORD', or 'param=<name>=env:<VAR>' for any secret parameter by name, a token in a navigate URL included. With --env/--base-url the environment's secretFields in ~/.jevitate/targets.json apply the same way; --param wins";

/** Collects a repeatable `--secret-field`. */
export const collectSecretField = (v: string, prev: string[]): string[] => [...prev, v];

/** A binding the operator gave that can't be used, as a command's `{code, message}` (value-free), or undefined. */
export function secretFieldErrorOf(err: unknown, argsCode: string): { code: string; message: string } | undefined {
  if (err instanceof BoundSecretOutsideFieldError) return { code: err.code, message: err.message };
  if (err instanceof SecretFieldSpecError || err instanceof SecretFieldAmbiguousError) return { code: argsCode, message: err.message };
  return undefined;
}

/**
 * #827: a secret parameter's value written in a file that is read at run time (a `check` suite's
 * `params`, a campaign spec's `params`) sits at rest, so it is refused by name, never echoing the value.
 * The way that works: a binding (`param=<name>=env:<VAR>`, or the field's) in the target's `secretFields`,
 * which holds only the variable's name, or the operator's `targets.json` for that origin.
 */
export function secretParamAtRestMessage(names: readonly string[], where: string): string {
  return (
    `secret parameter${names.length === 1 ? "" : "s"} ${names.join(", ")}: a secret value in ${where} sits in a file at rest, so nothing ran. ` +
    `Take it out and bind it instead: ${names.map((n) => `'param=${n}=env:<VAR>'`).join(", ")} in the target's secretFields (the file holds only the variable's name), or in ~/.jevitate/targets.json for that origin. ` +
    `A \${setup.x} reference (a fixture's output) is not a value and stays allowed`
  );
}

/** #827: which of `specs` bind a secret parameter of `journey` (a malformed spec or an unset variable throws, value-free). */
export function specsBinding(journey: Journey, specs: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] {
  return [...new Set(specs)].filter((spec) => paramsFromFields(journey, [replayField(spec, env)]).used.size > 0);
}
