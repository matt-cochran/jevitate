import { z } from "zod";
import { encodeUrlParamValue, isSecretName } from "@jevitate/recording";
import type { Job } from "./catalog-schema.js";
import type { Journey } from "./journey.js";
import { journeyWriteSteps, type JourneyLintOptions } from "./lint.js";
import { loadRefusedParamNames } from "./intent.js";

/**
 * #800 (docs/design/0.30.0-evidence-and-trust.md §3): the job done check — a path-independent
 * statement about the application's state that is false before a job is done and true after. It
 * lives on the job (`.jevitate/jobs.json` → `jobs[].done`); it is read in a fresh session at `at`,
 * before step 1 and after the last step, so it can name only state, never a step of one path.
 *
 * This module is the contract: the spec's shape (`DoneCheckSpecSchema`, the same shape as
 * `@jevitate/adjudicator`'s evidence schema), its parse (`parseDoneCheck`), placeholder resolution
 * (`resolveDoneCheck`) and the catalog lint (`lintDoneCheck`). No message here ever quotes a
 * parameter or extracted value: issues name the field, the placeholder name and a code.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The done check as stored. Mirrors `DoneCheckSpecSchema` in @jevitate/adjudicator (evidence.ts). */
export const DoneCheckSpecSchema = z
  .object({
    version: z.literal(1),
    /** A path on the target origin; `${param}` placeholders allowed (`${secret}` is refused at lint). */
    at: z.string().max(2048),
    /** The `--success` syntax of a state-naming check: `textIncludes`, `count`, `attr`, `valueEquals`, `http`. */
    check: z.string().max(1000),
    session: z.literal("fresh").optional(),
    distinguishedBy: z.array(z.string().max(128).regex(NAME)).optional(),
  })
  .strict();
export type DoneCheckSpec = z.infer<typeof DoneCheckSpecSchema>;

/** The check kinds a done check may use: each names state, none names a step. */
export const DONE_CHECK_KINDS = ["textIncludes", "count", "attr", "valueEquals", "http"] as const;
export type DoneCheckKind = (typeof DONE_CHECK_KINDS)[number];

export const E_DONE_CHECK_SHAPE = "E_DONE_CHECK_SHAPE";
export const E_DONE_CHECK_KIND = "E_DONE_CHECK_KIND";
export const E_DONE_CHECK_SYNTAX = "E_DONE_CHECK_SYNTAX";
export const E_DONE_CHECK_AT = "E_DONE_CHECK_AT";
/** A placeholder names a secret or a credential-like binding: its value would land in a model-visible URL or text. */
export const E_DONE_CHECK_SECRET_REF = "E_DONE_CHECK_SECRET_REF";
/** The spec names a step, an anchor or a `reloadThen`: a reading of one path, not of the application's state. */
export const E_DONE_CHECK_PATH_BOUND = "E_DONE_CHECK_PATH_BOUND";
/** A placeholder names nothing the run binds (a non-secret parameter or an `extract` output). */
export const E_DONE_CHECK_REF_UNBOUND = "E_DONE_CHECK_REF_UNBOUND";

export type DoneCheckIssueCode =
  | typeof E_DONE_CHECK_SHAPE
  | typeof E_DONE_CHECK_KIND
  | typeof E_DONE_CHECK_SYNTAX
  | typeof E_DONE_CHECK_AT
  | typeof E_DONE_CHECK_SECRET_REF
  | typeof E_DONE_CHECK_PATH_BOUND
  | typeof E_DONE_CHECK_REF_UNBOUND;

/** One problem with a done check. `message` names the field and placeholder, never a value. */
export interface DoneCheckIssue {
  readonly code: DoneCheckIssueCode;
  readonly field: "spec" | "version" | "at" | "check" | "session" | "distinguishedBy";
  /** The placeholder name, when the issue is about one. */
  readonly ref?: string;
  readonly message: string;
}

/**
 * What placeholders may name. `bound`: the non-secret parameters and `extract` outputs a run binds
 * (`doneCheckScope(journey)`); when given, any other name is `E_DONE_CHECK_REF_UNBOUND`. `secret`:
 * names declared secret beyond what `isSecretName` already catches.
 */
export interface DoneCheckScope {
  readonly bound?: Iterable<string>;
  readonly secret?: Iterable<string>;
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** `step:<n>`, `step-request:<n>:<i>`, `end-state:<i>` (mutation-proof site names) or an `anchor:`/`anchor=` reference. */
const PATH_BOUND_TOKEN = /(?<![A-Za-z0-9_-])(?:step(?:-request)?:\s*\d|end-state:\s*\d|anchors?\s*[:=])/i;
/** A placeholder that reaches into one path's state: `${step.3}`, `${anchor.x}`. */
const PATH_BOUND_REF = /^(?:step|steps|anchor|anchors)(?:[.:-]|$)/i;
const SETUP_REF = /^setup\.[^.]+/;

/** Every `${name}` in the spec's `at` and `check`, in order, de-duplicated. */
export function doneCheckPlaceholders(spec: Pick<DoneCheckSpec, "at" | "check">): string[] {
  const out = new Set<string>();
  for (const text of [spec.at, spec.check]) for (const m of text.matchAll(PLACEHOLDER)) out.add(m[1]!);
  return [...out];
}

function isSecretRef(name: string, secret: ReadonlySet<string>): boolean {
  return secret.has(name) || isSecretName(name) || isSecretName(name.replace(/^setup\./, ""));
}

function syntaxIssues(field: "at" | "check", text: string): DoneCheckIssue[] {
  const out: DoneCheckIssue[] = [];
  const stripped = text.replace(PLACEHOLDER, "");
  if (stripped.includes("${")) out.push({ code: E_DONE_CHECK_SYNTAX, field, message: `${field}: an unclosed \${ placeholder` });
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!PLACEHOLDER_NAME.test(name)) {
      out.push({ code: E_DONE_CHECK_SYNTAX, field, message: `${field}: a placeholder must be \${name} (letters, digits, _ . -)` });
    }
  }
  return out;
}

function refIssues(field: "at" | "check", text: string, scope: DoneCheckScope): DoneCheckIssue[] {
  const out: DoneCheckIssue[] = [];
  const secret = new Set(scope.secret ?? []);
  const bound = scope.bound === undefined ? undefined : new Set(scope.bound);
  const seen = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) {
    const ref = m[1]!;
    if (!PLACEHOLDER_NAME.test(ref) || seen.has(ref)) continue;
    seen.add(ref);
    if (PATH_BOUND_REF.test(ref)) {
      out.push({ code: E_DONE_CHECK_PATH_BOUND, field, ref, message: `${field}: \${${ref}} names a step or an anchor of one path; a done check reads only state` });
    } else if (isSecretRef(ref, secret)) {
      out.push({ code: E_DONE_CHECK_SECRET_REF, field, ref, message: `${field}: \${${ref}} names a secret or a credential-like binding; a done check may not carry one` });
    } else if (bound !== undefined && !bound.has(ref) && !SETUP_REF.test(ref)) {
      out.push({ code: E_DONE_CHECK_REF_UNBOUND, field, ref, message: `${field}: \${${ref}} is not a non-secret parameter or an extract output of the Journey` });
    }
  }
  return out;
}

/** A path on the target origin: starts with one `/`, no scheme, host, backslash, whitespace or control character. */
function originPathProblem(path: string): string | undefined {
  if (!path.startsWith("/")) return "must be a path on the target origin, starting with /";
  if (path.startsWith("//")) return "must be a path on the target origin, not a protocol-relative URL";
  if (/[\\\s\p{Cc}]/u.test(path)) return "may not contain a backslash, whitespace or a control character";
  return undefined;
}

/** The descriptor part (`<d>` before the split) must be present. */
function shapeOf(kind: DoneCheckKind, body: string): string | undefined {
  const split = (at: "first" | "last"): [string, string] | undefined => {
    const i = at === "last" ? body.lastIndexOf("|") : body.indexOf("|");
    return i < 0 ? undefined : [body.slice(0, i), body.slice(i + 1)];
  };
  switch (kind) {
    case "textIncludes":
    case "valueEquals": {
      const parts = split("last");
      if (parts === undefined || parts[0].trim() === "") return `${kind}:<target>|<text>`;
      return undefined;
    }
    case "count": {
      const parts = split("last");
      if (parts === undefined || parts[0].trim() === "" || !/^(?:min=\d+)?(?:,?max=\d+)?$/.test(parts[1].trim()) || parts[1].trim() === "") {
        return "count:<target>|min=<n>,max=<n>";
      }
      return undefined;
    }
    case "attr": {
      const parts = split("last");
      if (parts === undefined || parts[0].trim() === "" || !/^!?[A-Za-z_:][A-Za-z0-9_:.-]*(?:=.*)?$/s.test(parts[1])) {
        return "attr:<target>|<name>=<value> (or <name>, or !<name>)";
      }
      return undefined;
    }
    case "http": {
      const m = /^GET\s+(\S[^|]*)(?:\|.*)?$/s.exec(body);
      if (m === null) return "http:GET <path>[|<assertion>…] (GET only)";
      const problem = originPathProblem(m[1]!.trim().replace(PLACEHOLDER, "x"));
      return problem === undefined ? undefined : `http: the URL ${problem}`;
    }
  }
}

/**
 * Parse a done check. Returns the spec, or every issue found (never a partial spec). `scope`, when
 * given, also checks that every placeholder names a non-secret parameter or an `extract` output.
 */
export function parseDoneCheck(spec: unknown, scope: DoneCheckScope = {}): DoneCheckSpec | DoneCheckIssue[] {
  const parsed = DoneCheckSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => {
      const head = i.path[0];
      const field = head === "version" || head === "at" || head === "check" || head === "session" || head === "distinguishedBy" ? head : "spec";
      // zod's own messages are about types and keys, but stay safe: name the path and the issue kind only.
      return { code: E_DONE_CHECK_SHAPE, field, message: `${i.path.join(".") || "spec"}: ${i.code === "unrecognized_keys" ? "unknown key" : `invalid (${i.code})`}` };
    });
  }
  const s = parsed.data;
  const issues: DoneCheckIssue[] = [];

  issues.push(...syntaxIssues("at", s.at), ...syntaxIssues("check", s.check));
  const atProblem = originPathProblem(s.at.replace(PLACEHOLDER, "x"));
  if (atProblem !== undefined) issues.push({ code: E_DONE_CHECK_AT, field: "at", message: `at: ${atProblem}` });

  for (const field of ["at", "check"] as const) {
    if (PATH_BOUND_TOKEN.test(s[field].replace(PLACEHOLDER, ""))) {
      issues.push({ code: E_DONE_CHECK_PATH_BOUND, field, message: `${field}: names a step or an anchor of one path; a done check reads only state` });
    }
  }

  const colon = s.check.indexOf(":");
  const kind = colon < 0 ? "" : s.check.slice(0, colon);
  const body = colon < 0 ? "" : s.check.slice(colon + 1);
  if (kind === "reloadThen") {
    issues.push({ code: E_DONE_CHECK_PATH_BOUND, field: "check", message: "check: reloadThen reloads the run's own page; a done check is already read in a fresh session" });
  } else if (!(DONE_CHECK_KINDS as readonly string[]).includes(kind)) {
    issues.push({ code: E_DONE_CHECK_KIND, field: "check", message: `check: the kind must be one of ${DONE_CHECK_KINDS.join(", ")}` });
  } else {
    const want = shapeOf(kind as DoneCheckKind, body);
    if (want !== undefined) issues.push({ code: E_DONE_CHECK_SYNTAX, field: "check", message: `check: expected ${want}` });
  }

  issues.push(...refIssues("at", s.at, scope), ...refIssues("check", s.check, scope));

  const refs = new Set(doneCheckPlaceholders(s));
  const secret = new Set(scope.secret ?? []);
  for (const name of s.distinguishedBy ?? []) {
    if (isSecretRef(name, secret)) {
      issues.push({ code: E_DONE_CHECK_SECRET_REF, field: "distinguishedBy", ref: name, message: `distinguishedBy: ${name} names a secret or a credential-like binding` });
    } else if (!refs.has(name)) {
      issues.push({ code: E_DONE_CHECK_SYNTAX, field: "distinguishedBy", ref: name, message: `distinguishedBy: ${name} is not a placeholder in at or check, so it cannot make the before reading false` });
    }
  }
  return issues.length === 0 ? s : issues;
}

export function isDoneCheckIssues(r: DoneCheckSpec | DoneCheckIssue[]): r is DoneCheckIssue[] {
  return Array.isArray(r);
}

/**
 * The names a Journey's run binds that a done check may name: its non-secret parameters (`params`,
 * `parameters`, less the secret ones) and every `extract` output. Pass to `parseDoneCheck`.
 */
export function doneCheckScope(journey: Journey): Required<DoneCheckScope> {
  const declaredSecret = new Set([
    ...loadRefusedParamNames(journey),
    ...(journey.metadata.parameters ?? []).filter((p) => p.secret === true).map((p) => p.name),
  ]);
  const bound = new Set([...journey.metadata.params, ...(journey.metadata.parameters ?? []).map((p) => p.name)].filter((n) => !declaredSecret.has(n)));
  for (const page of journey.recording.pages) {
    for (const r of page.steps) {
      if (r.step.kind === "extract") bound.add(r.step.as);
      if (r.step.kind === "forEach") for (const c of r.step.steps) if (c.kind === "extract") bound.add(c.as);
    }
  }
  return { bound: [...bound].sort(), secret: [...declaredSecret].sort() };
}

/**
 * Resolve a parsed spec's placeholders for one reading. In `at` and an `http` URL each value is
 * percent-encoded as one URL component (as a navigate URL is); elsewhere it is inserted as is.
 * Fails closed: an unbound, secret or path-bound name is an issue that names it, never its value.
 */
export function resolveDoneCheck(
  spec: DoneCheckSpec,
  values: Readonly<Record<string, string>>,
  scope: DoneCheckScope = {},
): { readonly at: string; readonly check: string } | DoneCheckIssue[] {
  const issues = [...refIssues("at", spec.at, scope), ...refIssues("check", spec.check, scope)];
  const sub = (field: "at" | "check", text: string, encode: boolean): string =>
    text.replace(PLACEHOLDER, (whole, ref: string) => {
      const v = values[ref];
      if (typeof v !== "string") {
        if (!issues.some((i) => i.ref === ref)) {
          issues.push({ code: E_DONE_CHECK_REF_UNBOUND, field, ref, message: `${field}: \${${ref}} has no value in this run` });
        }
        return whole;
      }
      return encode ? encodeUrlParamValue(v) : v;
    });
  const at = sub("at", spec.at, true);
  let check: string;
  if (spec.check.startsWith("http:")) {
    const pipe = spec.check.indexOf("|");
    const url = pipe < 0 ? spec.check : spec.check.slice(0, pipe);
    const rest = pipe < 0 ? "" : spec.check.slice(pipe);
    check = sub("check", url, true) + sub("check", rest, false);
  } else {
    check = sub("check", spec.check, false);
  }
  return issues.length === 0 ? { at, check } : issues;
}

export type DoneCheckLintRule = "missing-done-check" | "done-check-cannot-be-false" | "done-check-invalid";

/** One done-check finding on a job (and the linked Journey it is about, when it is about one). */
export interface DoneCheckLintFinding {
  readonly rule: DoneCheckLintRule;
  readonly level: "error" | "warning";
  readonly job: string;
  readonly journey?: string;
  readonly code?: DoneCheckIssueCode;
  readonly message: string;
  readonly fix?: string;
}

/**
 * §3 catalog lint for one job against the Journeys (any set; those linked by `metadata.job` count):
 *  - `missing-done-check` (warning): a promoted linked Journey whose job has no `done`;
 *  - `done-check-invalid` (error): the job's `done` does not parse (`parseDoneCheck`, scoped to each
 *    linked Journey's bindings);
 *  - `done-check-cannot-be-false` (warning): a linked Journey writes (`journeyWriteSteps`) and the
 *    check has no `distinguishedBy`, so nothing makes the before reading false: a second run reads
 *    `already-true` and proves nothing.
 */
export function lintDoneCheck(job: Pick<Job, "id"> & { readonly done?: unknown }, journeys: readonly Journey[], opts: JourneyLintOptions = {}): DoneCheckLintFinding[] {
  const linked = journeys.filter((j) => j.metadata.job === job.id);
  const out: DoneCheckLintFinding[] = [];
  if (job.done === undefined) {
    for (const j of linked) {
      if (!j.metadata.promoted) continue;
      out.push({
        rule: "missing-done-check",
        level: "warning",
        job: job.id,
        journey: j.metadata.id,
        message: `job ${job.id} has no done check: journey ${j.metadata.id} reads unverified (no-check)`,
        fix: `add a done check to job ${job.id} in .jevitate/jobs.json: { "version": 1, "at": "/path", "check": "textIncludes:<target>|<text>" }`,
      });
    }
    return out;
  }

  const scopes = linked.length === 0 ? [{ journey: undefined, scope: {} as DoneCheckScope }] : linked.map((j) => ({ journey: j.metadata.id, scope: doneCheckScope(j) as DoneCheckScope }));
  const reported = new Set<string>();
  let spec: DoneCheckSpec | undefined;
  for (const { journey, scope } of scopes) {
    const parsed = parseDoneCheck(job.done, scope);
    if (!isDoneCheckIssues(parsed)) {
      spec = parsed;
      continue;
    }
    for (const issue of parsed) {
      const key = `${issue.code}|${issue.field}|${issue.ref ?? ""}|${issue.code === E_DONE_CHECK_REF_UNBOUND ? (journey ?? "") : ""}`;
      if (reported.has(key)) continue;
      reported.add(key);
      out.push({
        rule: "done-check-invalid",
        level: "error",
        job: job.id,
        ...(issue.code === E_DONE_CHECK_REF_UNBOUND && journey !== undefined ? { journey } : {}),
        code: issue.code,
        message: `job ${job.id} done check: ${issue.message}`,
      });
    }
  }
  if (spec === undefined && out.length > 0) {
    // Still read the shape for the cannot-be-false rule when only the scope refused it.
    const shape = DoneCheckSpecSchema.safeParse(job.done);
    if (shape.success) spec = shape.data;
  }
  if (spec === undefined) return out;

  if ((spec.distinguishedBy ?? []).length === 0) {
    for (const j of linked) {
      const writes = journeyWriteSteps(j, opts);
      if (writes.length === 0) continue;
      out.push({
        rule: "done-check-cannot-be-false",
        level: "warning",
        job: job.id,
        journey: j.metadata.id,
        message: `journey ${j.metadata.id} writes (step ${writes[0]!.step}) and job ${job.id}'s done check names no distinguishedBy: after one run the check is already true, so a later run reads already-true and proves nothing`,
        fix: `name the parameter whose value the Journey creates fresh each run in done.distinguishedBy, and use it as a \${placeholder} in done.at or done.check`,
      });
    }
  }
  return out;
}
