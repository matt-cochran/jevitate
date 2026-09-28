import { expressionObservables, parseInvariantExpression, type ExprNode } from "./expression.js";
import { CAPTURE_REF_RE } from "./internal.js";
import { captureRefs, invariantGate, type CaptureSpec } from "./capture.js";
import { probeUrl, resolveHttpUrl } from "./probe.js";
import type { ObservableSpec } from "./observable.js";
// `InvariantSpecSchema` is a genuine runtime dependency (this module calls `.safeParse` on it); the
// other imports below are type-only and erased, so this is not a real circular-value dependency —
// `invariants.ts` in turn imports this module's exports for its `export *` barrel.
import { InvariantSpecSchema, type BudgetDeclaration, type DeclaredInvariant, type InvariantSpec } from "../invariants.js";

/** A refused spec: every problem, each prefixed with its path (`invariants[2].require: …`). */
export class InvariantSpecError extends Error {
  readonly code = "E_INVARIANTS" as const;
  constructor(readonly problems: readonly string[]) {
    super(`invalid invariants: ${problems.join("; ")}`);
    this.name = "InvariantSpecError";
  }
}

/** `["invariants", 2, "observe"]` → `invariants[2].observe`. */
export function formatSpecPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out === "" ? "(root)" : out;
}

interface SpecIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * The spec's cross-reference problems (#213: a duplicate invariant id, an unknown observable or
 * capture, a cross-actor read with no gate, "at least one of invariants or budget") — recomputed
 * from the RAW input, defensively (every field is duck-typed, never assumed to be the right shape).
 *
 * Why this duplicates `InvariantSpecObjectSchema`'s own `superRefine` logic: zod does not run a
 * `superRefine` once ANY nested field's parse aborts (a wrong type, an unrecognized `.strict()` key,
 * …) — so a spec with an unrelated type error used to lose every one of these checks along with it,
 * reporting only the type error and hiding real problems elsewhere in the same file. `raw` has no
 * such failure mode: it is read defensively here regardless of what else is wrong with the spec, and
 * `validateInvariantSpec` merges its findings with the schema's own. The schema's `superRefine` is
 * left as-is for its other direct callers (`parsePersistedMission`, `MissionRequestSchema`).
 */
function crossReferenceProblems(raw: unknown): SpecIssue[] {
  const spec = asRecord(raw);
  if (spec === undefined) return [];
  const issues: SpecIssue[] = [];
  const captureObj = asRecord(spec.capture) ?? {};
  const observeObj = asRecord(spec.observe) ?? {};
  const declared = new Set(Object.keys(observeObj));
  const captures = new Set(Object.keys(captureObj));
  for (const n of captures) {
    if (declared.has(n)) issues.push({ path: ["capture", n], message: `${JSON.stringify(n)} is both a capture and an observable` });
  }
  const probeOf = (o: unknown): Record<string, unknown> | undefined => {
    const rec = asRecord(o);
    return rec === undefined ? undefined : asRecord(rec.probe);
  };
  for (const [name, o] of Object.entries(observeObj)) {
    const probe = probeOf(o);
    if (probe === undefined) continue;
    const tpl = typeof probe.get === "string" ? probe.get : typeof probe.head === "string" ? probe.head : "";
    for (const ref of captureRefs(tpl)) {
      if (!captures.has(ref)) issues.push({ path: ["observe", name, "probe"], message: `unknown capture ${JSON.stringify(ref)}` });
    }
  }
  const observerObservables = new Set(
    Object.entries(observeObj)
      .filter(([, o]) => probeOf(o)?.as !== undefined)
      .map(([n]) => n),
  );
  const invariantsRaw = Array.isArray(spec.invariants) ? spec.invariants : [];
  const budgetRaw = Array.isArray(spec.budget) ? spec.budget : [];
  if (invariantsRaw.length === 0 && budgetRaw.length === 0) {
    issues.push({ path: ["invariants"], message: "at least one of invariants or budget is required" });
  }
  const ids = new Set<string>();
  invariantsRaw.forEach((invRaw, i) => {
    const inv = asRecord(invRaw);
    if (inv === undefined) return; // reported by the schema's own type check
    if (typeof inv.id === "string") {
      if (ids.has(inv.id)) issues.push({ path: ["invariants", i, "id"], message: `duplicate invariant id ${JSON.stringify(inv.id)}` });
      ids.add(inv.id);
    }
    const gate = invariantGate(inv as { when?: { after?: string } });
    if (gate !== null && !captures.has(gate)) {
      issues.push({ path: ["invariants", i, "when", "after"], message: `unknown capture ${JSON.stringify(gate)}` });
    }
    const deniedAs = asRecord(inv.deniedAs);
    if (deniedAs !== undefined && typeof deniedAs.open === "string") {
      for (const ref of captureRefs(deniedAs.open)) {
        if (!captures.has(ref)) issues.push({ path: ["invariants", i, "deniedAs", "open"], message: `unknown capture ${JSON.stringify(ref)}` });
      }
    }
    if (typeof inv.require !== "string") return;
    let ast: ExprNode;
    try {
      ast = parseInvariantExpression(inv.require);
    } catch {
      return; // reported by the expression's own refinement
    }
    for (const name of expressionObservables(ast)) {
      if (!declared.has(name) && !captures.has(name)) {
        issues.push({ path: ["invariants", i, "require"], message: `unknown observable ${JSON.stringify(name)}` });
      }
      if (observerObservables.has(name) && gate === null) {
        issues.push({
          path: ["invariants", i, "when"],
          message: `${JSON.stringify(name)} is read as another actor: the invariant needs when.after: "capture.<name>"`,
        });
      }
    }
  });
  budgetRaw.forEach((bRaw, i) => {
    const b = asRecord(bRaw);
    if (b === undefined) return;
    if (typeof b.observe === "string" && !declared.has(b.observe)) {
      issues.push({ path: ["budget", i, "observe"], message: `unknown observable ${JSON.stringify(b.observe)}` });
    }
    const guard = asRecord(b.guard);
    if (guard !== undefined && typeof guard.estimate === "string" && !declared.has(guard.estimate)) {
      issues.push({ path: ["budget", i, "guard", "estimate"], message: `unknown observable ${JSON.stringify(guard.estimate)}` });
    }
  });
  return issues;
}

/**
 * The observer actor a cross-actor invariant checks from (#147): its `deniedAs.actor`, or the
 * `as:` of the first observable its expression reads. Null for a primary-only invariant.
 */
export function invariantObserver(spec: InvariantSpec, inv: DeclaredInvariant): string | null {
  if (inv.deniedAs !== undefined) return inv.deniedAs.actor;
  if (inv.require === undefined) return null;
  let ast: ExprNode;
  try {
    ast = parseInvariantExpression(inv.require);
  } catch {
    return null;
  }
  for (const name of expressionObservables(ast)) {
    const o = spec.observe?.[name];
    if (o !== undefined && "probe" in o && o.probe.as !== undefined) return o.probe.as;
  }
  return null;
}

/** Every actor a spec names (probe `as:`, `deniedAs.actor`), deduped (#147). */
export function invariantActors(spec: InvariantSpec): string[] {
  const out = new Set<string>();
  for (const o of Object.values(spec.observe ?? {})) if ("probe" in o && o.probe.as !== undefined) out.add(o.probe.as);
  for (const inv of spec.invariants) if (inv.deniedAs !== undefined) out.add(inv.deniedAs.actor);
  return [...out];
}

/** A capture template with every ref replaced by a harmless placeholder: its ORIGIN is checkable. */
function placeholderUrl(template: string): string {
  return template.replace(CAPTURE_REF_RE, "x");
}

function originOf(s: string): string | null {
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/**
 * The concrete (wildcard-free) origin a `never.response.url` glob begins with, or null when the
 * glob has no such literal prefix (a bare path, or a wildcarded scheme/host `https://*.x.test/…`
 * that may still resolve onto an authorized origin at request time — left unchecked here).
 */
function literalGlobOrigin(urlGlob: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/*?]+/i.exec(urlGlob);
  if (m === null) return null;
  return originOf(m[0]);
}

export interface ValidateInvariantOptions {
  /** Authorized origins: every probe must resolve onto one. Required when the spec has probes. */
  readonly allowlist?: readonly string[];
  /** What relative probe paths resolve against (the mission's start URL / target base URL). */
  readonly baseUrl?: string;
  /**
   * The registered OBSERVER actors (#147: every `--actor` but the primary). Every probe `as:` and
   * `deniedAs.actor` must name one; with none registered, a spec naming an actor is refused.
   */
  readonly observers?: readonly string[];
}

/**
 * Validates a raw spec and authorizes its probes — the dispatch-time gate. Throws
 * `InvariantSpecError` listing every problem with its path; returns the typed spec otherwise.
 * A probe whose origin is not on `allowlist` (or that cannot be resolved) is refused here, so a
 * bad spec never reaches a browser.
 */
export function validateInvariantSpec(raw: unknown, opts: ValidateInvariantOptions = {}): InvariantSpec {
  const parsed = InvariantSpecSchema.safeParse(raw);
  // #213: computed independently of whether the schema parse succeeded — see `crossReferenceProblems`.
  const crossRef = crossReferenceProblems(raw).map((i) => `${formatSpecPath(i.path)}: ${i.message}`);
  if (!parsed.success) {
    const shapeProblems = parsed.error.issues.map((i) => `${formatSpecPath(i.path)}: ${i.message}`);
    const extra = crossRef.filter((p) => !shapeProblems.includes(p));
    throw new InvariantSpecError([...shapeProblems, ...extra]);
  }
  const spec = parsed.data;
  const problems: string[] = [...crossRef];
  const allowed = new Set((opts.allowlist ?? []).map(originOf).filter((o): o is string => o !== null));
  const observers = new Set(opts.observers ?? []);
  const urlCaptures = new Set(Object.entries(spec.capture ?? {}).filter(([, c]) => "url" in c).map(([n]) => n));
  const checkActor = (actor: string, at: string): void => {
    if (observers.has(actor)) return;
    problems.push(
      observers.size === 0
        ? `${at}: actor ${JSON.stringify(actor)} is not registered (pass --actor <primary>=<state> --actor ${actor}=<state>)`
        : `${at}: actor ${JSON.stringify(actor)} is not a registered observer (have: ${[...observers].join(", ")})`,
    );
  };
  // A template that STARTS with a capture takes its origin from the captured value: only a `url`
  // capture (the primary's own, already-authorized page URL) may do that. Re-checked at request time.
  const leadingCapture = (template: string, at: string): boolean => {
    const lead = /^\$\{capture\.([A-Za-z_][A-Za-z0-9_]*)\}/.exec(template);
    if (lead === null) return false;
    if (!urlCaptures.has(lead[1] as string)) problems.push(`${at}: only a url capture may start a URL (it would set the origin)`);
    return true;
  };
  spec.invariants.forEach((inv, i) => {
    if (inv.never !== undefined && "response" in inv.never) {
      const at = `invariants[${i}].never.response.url`;
      const url = inv.never.response.url;
      // A glob starting with "/" is matched path-only against ANY authorized origin's response
      // (`matchesUrlGlob` in declared-invariants.ts) — always reachable. An absolute glob whose HOST
      // is a concrete, wildcard-free origin is matched against the full URL, but the listener only
      // ever tests responses `isAuthorizedExploreTarget` already let through — an unauthorized
      // literal origin can therefore never fire. A wildcarded origin (`https://*.x.test/...`) is left
      // alone: it may still resolve onto an authorized origin at request time.
      if (!url.startsWith("/") && (opts.baseUrl !== undefined || opts.allowlist !== undefined)) {
        const origin = literalGlobOrigin(url);
        if (origin !== null && (opts.allowlist === undefined || !allowed.has(origin))) {
          problems.push(
            `${at}: origin ${origin} is not an authorized origin — never.response only watches the mission's own ` +
              `authorized traffic and this rule can never fire (use a leading "/" path glob to match any authorized origin, or add --allow ${origin})`,
          );
        }
      }
    }
    if (inv.deniedAs === undefined) return;
    const at = `invariants[${i}].deniedAs`;
    checkActor(inv.deniedAs.actor, `${at}.actor`);
    if (leadingCapture(inv.deniedAs.open, `${at}.open`)) return;
    if (opts.baseUrl === undefined || opts.allowlist === undefined) {
      problems.push(`${at}.open: needs the mission's authorized origins to be checked against`);
      return;
    }
    const u = resolveHttpUrl(placeholderUrl(inv.deniedAs.open), opts.baseUrl);
    if (u === null) problems.push(`${at}.open: not an http(s) URL or path`);
    else if (u.username !== "" || u.password !== "") problems.push(`${at}.open: a URL may not carry credentials`);
    else if (!allowed.has(u.origin)) problems.push(`${at}.open: origin ${u.origin} is not an authorized origin`);
  });
  for (const [name, o] of Object.entries(spec.observe ?? {})) {
    if (!("probe" in o)) continue;
    const at = `observe.${name}.probe`;
    if (o.probe.as !== undefined) checkActor(o.probe.as, `${at}.as`);
    if (leadingCapture(o.probe.get ?? o.probe.head ?? "", at)) continue;
    if (opts.baseUrl === undefined || opts.allowlist === undefined) {
      problems.push(`${at}: a probe needs the mission's authorized origins to be checked against`);
      continue;
    }
    const tpl = o.probe.get ?? o.probe.head ?? "";
    const u = probeUrl(o.probe.get !== undefined ? { get: placeholderUrl(tpl) } : { head: placeholderUrl(tpl) }, opts.baseUrl);
    if (u === null) {
      problems.push(`${at}: not an http(s) URL or path`);
      continue;
    }
    if (u.username !== "" || u.password !== "") {
      problems.push(`${at}: a probe URL may not carry credentials`);
      continue;
    }
    if (!allowed.has(u.origin)) problems.push(`${at}: origin ${u.origin} is not an authorized origin`);
  }
  if (problems.length > 0) throw new InvariantSpecError(problems);
  return spec;
}

/**
 * Merges several specs (repeatable `--invariants`) into one. An observable declared twice with a
 * different definition, or a repeated invariant id, is refused rather than silently shadowed.
 */
export function mergeInvariantSpecs(specs: readonly InvariantSpec[]): InvariantSpec {
  const observe: Record<string, ObservableSpec> = {};
  const capture: Record<string, CaptureSpec> = {};
  const invariants: DeclaredInvariant[] = [];
  const budget: BudgetDeclaration[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  specs.forEach((s, f) => {
    for (const [name, c] of Object.entries(s.capture ?? {})) {
      const known = capture[name];
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(c)) {
        problems.push(`file ${f + 1}: capture.${name}: declared differently in an earlier file`);
      }
      capture[name] = c;
    }
    for (const [name, o] of Object.entries(s.observe ?? {})) {
      const known = observe[name];
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(o)) {
        problems.push(`file ${f + 1}: observe.${name}: declared differently in an earlier file`);
      }
      observe[name] = o;
    }
    for (const inv of s.invariants) {
      if (ids.has(inv.id)) problems.push(`file ${f + 1}: invariant id ${JSON.stringify(inv.id)} repeats an earlier file's`);
      ids.add(inv.id);
      invariants.push(inv);
    }
    budget.push(...(s.budget ?? []));
  });
  if (problems.length > 0) throw new InvariantSpecError(problems);
  return {
    ...(Object.keys(capture).length > 0 ? { capture } : {}),
    ...(Object.keys(observe).length > 0 ? { observe } : {}),
    invariants,
    ...(budget.length > 0 ? { budget } : {}),
  };
}

/**
 * Every `authFrom.secret` ref (`env:VAR`) a spec's probes use (#135), deduped — what the dispatch
 * resolves from the environment before any browser opens (never read here: this module is pure).
 */
export function invariantAuthSecretRefs(spec: InvariantSpec): string[] {
  const refs = new Set<string>();
  for (const o of Object.values(spec.observe ?? {})) {
    if ("probe" in o && o.probe.authFrom?.secret !== undefined) refs.add(o.probe.authFrom.secret);
  }
  return [...refs];
}
