import { journeyCatalogGate, resolveCatalogDir } from "./catalog-api.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FsJourneyStore,
  applyAnnotationDraft,
  deriveParamSchema,
  describeStep,
  flatJourneySteps,
  type AnnotationChange,
  type AnnotationDraft,
  type Journey,
} from "@jevitate/journey";
import type { Assertion, Recording } from "@jevitate/recording";
import type { GenerationPort, JudgmentPort } from "@jevitate/ai-core";
import { assertNoSecretInPayload } from "@jevitate/ai-core";
import type { Bounds, SafetyConfig } from "@jevitate/explore";
import { minimizeRecording } from "@jevitate/regression";
import type { BrowserPort, EmulationSpec } from "@jevitate/playwright";
import type { SiteGateDeps } from "@jevitate/runtime";
import { runAuthorJourney, type AuthorViaBrowserArgs } from "./explore-author.js";
import type { AuthorJourneyResult } from "@jevitate/explore";
import { promoteJourney, runJourneyProgrammatically, UnknownJourneyError } from "./journey-api.js";
import {
  annotateJourney,
  annotationDraftPath,
  approveJourneyAnnotations,
  journeyContentHash,
  readAnnotationDraft,
  StaleAnnotationDraftError,
} from "./journey-annotate-api.js";
import { demoJourney, type DemoJourneyResult } from "./journey-demo-api.js";
import type { CaptureLayer } from "./demo-capture.js";
import type { BrowserRunOptions } from "./browser-run-options.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import type { MissionFixtures } from "./mission-fixtures.js";
import { clock } from "@jevitate/domain";

/**
 * #249 — `jevitate demo "<aspect>"`: one request → a reviewed, narrated demo of one aspect of an app.
 *
 *  1. Explore and author: goal-directed exploration (`runAuthorJourney`, the `explore-author-journey`
 *     path) writes a Journey for the aspect, gated by an INDEPENDENT success check (`--success`) —
 *     Jev drives, code adjudicates. Paid/destructive controls are refused unless the target's
 *     targets.json `safety` allows them; writes are allowed (there is a success check).
 *  2. Clean path: the explored path is minimized to its essential steps with the regression-capture
 *     ddmin (`minimizeRecording`): a step (a detour, a dead end, a repeated attempt) is dropped only
 *     when the Journey still REPLAYS to its success check without it. The success check is always
 *     the Journey's last step, so a candidate can never "succeed" by dropping the proof. The
 *     explored path must replay before minimizing, and the minimized one is replayed once more.
 *  3. Annotate (#246): a replay drafts each step's objective and expected result (sidecar draft).
 *  4. Draft demo (#248): video + .vtt + guide narrated with the DRAFT annotations, every output
 *     marked DRAFT (a watermark on the overlay, in the subtitles and in the guide).
 *
 * Everything runs in a scratch store first: the Journey, its annotation draft and the demo record
 * land in the journeys dir only when every stage succeeded, and the Journey is NEVER promoted here.
 * `approveDemo` is the one human gate: it re-renders the final (non-DRAFT) demo with the reviewed
 * annotations and only then applies them and promotes the Journey — an ordinary Journey thereafter.
 *
 * Safety: only a named environment, never one flagged `production: true` (refused before anything
 * runs); every replay has `journey run`'s fail-closed policy; every output is redacted and proven
 * secret-free by the stages it reuses.
 */

/** The demo's inputs were unusable: nothing ran. */
export class DemoAspectArgsError extends Error {
  readonly code = "E_DEMO_ARGS";
}
/** `demo` against an environment flagged `production: true`: refused before anything runs. */
export class DemoProductionEnvironmentError extends Error {
  readonly code = "E_DEMO_PRODUCTION_ENV";
}
/** The Journey id (or its demo draft) already exists: refused, nothing overwritten. */
export class DemoExistsError extends Error {
  readonly code = "E_DEMO_EXISTS";
}
/** `demo approve <id>` for an id with no demo draft. */
export class DemoDraftNotFoundError extends Error {
  readonly code = "E_DEMO_NOT_FOUND";
}
/** The demo draft record is unreadable or not a demo draft. */
export class InvalidDemoDraftError extends Error {
  readonly code = "E_INVALID_DEMO_DRAFT";
}

/** How many minimization replays (beyond the two verification replays) a demo may spend. */
export const DEMO_MINIMIZE_MAX_REPLAYS = 40;

/** Refuses a missing environment, and one flagged `production: true` (#249). */
export function assertDemoEnvironment(environment: ResolvedJourneyEnvironment | undefined): asserts environment is ResolvedJourneyEnvironment {
  if (environment === undefined || environment.name === undefined) {
    throw new DemoAspectArgsError("demo runs only against a named environment: pass --env <name> (from .jevitate/environments.json)");
  }
  if (environment.production === true) {
    throw new DemoProductionEnvironmentError(
      `environment '${environment.name}' is flagged production: true — demo explores and writes, so it runs only against a non-production environment`,
    );
  }
}

/** `demo-<slug of the aspect>`: a safe Journey id. */
export function demoJourneyId(aspect: string): string {
  const slug = aspect
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `demo-${slug === "" ? "aspect" : slug}`;
}

const DEMO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `<journeys>/.drafts/<id>.demo.json` — beside the Journey's annotation draft (a dot-folder: never listed as a Journey). */
export function demoDraftPath(journeysDir: string, id: string): string {
  return join(journeysDir, ".drafts", `${id}.demo.json`);
}

/** The demo draft record: what `demo approve` needs besides the Journey and its annotation draft. Never a secret. */
export interface DemoDraft {
  readonly kind: "jevitate.demo.draft";
  readonly version: 1;
  readonly id: string;
  readonly aspect: string;
  /** The environment the demo was made on (approve re-renders there, re-checking it is not production). */
  readonly env: string;
  readonly persona?: string;
  /** The Journey's content hash when drafted (its annotation draft is bound to the same). */
  readonly journeyHash: string;
  readonly createdAtIso: string;
  /** The DRAFT outputs. */
  readonly draft: { readonly video?: string; readonly subtitles?: string; readonly guide?: string };
}

/** Why `v` is not a {@link DemoDraft}, or null when it is. */
function demoDraftProblem(v: unknown): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "not an object";
  const o = v as Record<string, unknown>;
  if (o.kind !== "jevitate.demo.draft") return "kind: expected jevitate.demo.draft";
  if (o.version !== 1) return "version: expected 1";
  for (const k of ["id", "aspect", "env", "journeyHash", "createdAtIso"]) if (typeof o[k] !== "string" || o[k] === "") return `${k}: expected a string`;
  if (o.persona !== undefined && typeof o.persona !== "string") return "persona: expected a string";
  const d = o.draft;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return "draft: expected an object";
  for (const [k, x] of Object.entries(d as Record<string, unknown>)) {
    if (!["video", "subtitles", "guide"].includes(k)) return `draft.${k}: unknown key`;
    if (typeof x !== "string") return `draft.${k}: expected a path`;
  }
  return null;
}

/** Reads and validates a demo draft record (missing / invalid are typed refusals). */
export async function readDemoDraft(journeysDir: string, id: string): Promise<{ record: DemoDraft; path: string }> {
  const path = demoDraftPath(journeysDir, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") throw new DemoDraftNotFoundError(`no demo draft '${id}' (${path}) — make one with \`jevitate demo "<aspect>" --env <name>\``);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidDemoDraftError(`${path} is not JSON`);
  }
  const problem = demoDraftProblem(parsed);
  if (problem !== null) throw new InvalidDemoDraftError(`${path} is not a demo draft: ${problem}`);
  const record = parsed as DemoDraft;
  if (record.id !== id) throw new InvalidDemoDraftError(`${path} is the demo draft for '${record.id}', not '${id}'`);
  return { record, path };
}

/** The replay-side options every stage shares (as `journey run` takes them). */
export interface DemoReplayOptions {
  readonly environment: ResolvedJourneyEnvironment;
  readonly storageState?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched and shown (`--headed` presents the demo; exploration and replays stay headless). */
  readonly browser?: BrowserRunOptions;
  readonly emulation?: EmulationSpec;
  readonly siteGate?: SiteGateDeps;
  readonly fixtures?: (site: string) => MissionFixtures | undefined;
  /** Caption time per step (ms). */
  readonly paceMs?: number;
  /** Extra screenshot layers (pixel masking, #250/#251). */
  readonly captureLayers?: readonly CaptureLayer[];
}

export interface DemoAspectOptions extends DemoReplayOptions {
  /** The aspect to demo, in words: the exploration's goal and the Journey's name. */
  readonly aspect: string;
  /** The independent success check that proves the aspect was shown (`--success`). */
  readonly successAssertion: Assertion;
  /** Its spec as given, for the Journey's success criterion text. */
  readonly successSpec: string;
  readonly journeysDir: string;
  /** Default {@link demoJourneyId}. */
  readonly id?: string;
  /** The path exploration starts from on the environment (default `/`). */
  readonly start?: string;
  readonly persona?: string;
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  /** The target's targets.json `safety` (paid/destructive allowed only when configured there). */
  readonly safety?: SafetyConfig;
  /** Where the draft video/subtitles/guide go (a folder). */
  readonly outDir: string;
  /** Default {@link DEMO_MINIMIZE_MAX_REPLAYS}. */
  readonly maxReplays?: number;
  readonly now?: () => string;
  /** Test seam: the authoring step (default: a real browser). */
  readonly authorImpl?: (args: AuthorViaBrowserArgs) => Promise<AuthorJourneyResult>;
}

export interface DemoMinimizeReport {
  readonly exploredSteps: number;
  readonly keptSteps: number;
  /** What was dropped (value-free step descriptions), in explored order. */
  readonly dropped: string[];
  /** Replays spent minimizing (the two verification replays not counted). */
  readonly replays: number;
  /** The replay budget ran out: the path is verified but may not be minimal. */
  readonly budgetExhausted: boolean;
}

export interface DemoAspectResult {
  readonly id: string;
  readonly aspect: string;
  readonly environment: string;
  /**
   * `drafted`: the Journey (unpromoted), its annotation draft and the DRAFT demo are written.
   * `not-reached`: exploration did not meet the success check. `not-replayable`: the explored or
   * minimized path did not replay to it. `stale`: the draft demo's replay stopped. Only `drafted` writes.
   */
  readonly outcome: "drafted" | "not-reached" | "not-replayable" | "stale";
  readonly reason?: string;
  readonly minimize?: DemoMinimizeReport;
  /** The Journey's steps as the demo narrates them (with the drafted annotations). */
  readonly steps?: Array<{ number: number; step: string; objective?: string; expectedResult?: string }>;
  readonly annotations?: { readonly draftPath: string; readonly proposed: AnnotationChange[] };
  readonly draft?: { readonly video?: string; readonly subtitles?: string; readonly guide?: string };
  readonly demoDraftPath?: string;
  /** The approval command (only for `drafted`). */
  readonly next?: string;
}

/** The replay-only browser: never headed, never recorded (minimizing opens many sessions). */
function quietBrowser(browser: BrowserRunOptions | undefined): BrowserRunOptions | undefined {
  if (browser === undefined) return undefined;
  const { headed: _h, recordVideo: _v, overlay: _o, slowMo: _s, ...launch } = browser;
  return launch;
}

function sameAssertion(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The explored Recording without its final success `assert` (authorJourney always appends it). */
function withoutSuccessAssert(recording: Recording, check: Assertion): Recording {
  const pages = recording.pages.map((p) => ({ ...p, steps: [...p.steps] }));
  const last = pages[pages.length - 1];
  const tail = last?.steps[last.steps.length - 1]?.step;
  if (last !== undefined && tail?.kind === "assert" && sameAssertion(tail.check, check)) {
    last.steps.pop();
    if (last.steps.length === 0) pages.pop();
  }
  return { ...recording, pages };
}

/** `recording` + the success check as its last step — the proof every candidate must replay to. */
function withSuccessAssert(recording: Recording, check: Assertion): Recording {
  const pages = recording.pages.map((p) => ({ ...p, steps: [...p.steps] }));
  const last = pages[pages.length - 1];
  if (last === undefined) return { ...recording, pages: [{ url: "/", steps: [{ step: { kind: "assert", check } }] }] };
  last.steps.push({ step: { kind: "assert", check } });
  return { ...recording, pages };
}

function stepsOf(journey: Journey): NonNullable<DemoAspectResult["steps"]> {
  return flatJourneySteps(journey).map((s) => ({
    number: s.index + 1,
    step: describeStep(s.recorded.step),
    ...(s.recorded.objective === undefined ? {} : { objective: s.recorded.objective }),
    ...(s.recorded.expectedResult === undefined ? {} : { expectedResult: s.recorded.expectedResult }),
  }));
}

function replayOpts(opts: DemoReplayOptions): Omit<DemoReplayOptions, "paceMs" | "captureLayers" | "browser"> & { browser?: BrowserRunOptions } {
  const b = quietBrowser(opts.browser);
  return {
    environment: opts.environment,
    ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(b === undefined ? {} : { browser: b }),
    ...(opts.emulation === undefined ? {} : { emulation: opts.emulation }),
    ...(opts.siteGate === undefined ? {} : { siteGate: opts.siteGate }),
    ...(opts.fixtures === undefined ? {} : { fixtures: opts.fixtures }),
  };
}

/** Runs the #249 pipeline (see the module comment). Refusals throw before anything runs. */
export async function demoAspect(opts: DemoAspectOptions): Promise<DemoAspectResult> {
  assertDemoEnvironment(opts.environment);
  const env = opts.environment;
  const aspect = opts.aspect.replace(/\s+/g, " ").trim();
  if (aspect === "") throw new DemoAspectArgsError("the aspect to demo is empty");
  const id = opts.id ?? demoJourneyId(aspect);
  if (!DEMO_ID.test(id)) throw new DemoAspectArgsError(`--id must be letters, digits, '.', '_' or '-' (starting with a letter or digit): ${JSON.stringify(id)}`);
  const start = opts.start ?? "/";
  if (!start.startsWith("/")) throw new DemoAspectArgsError(`--start must be an app path starting with '/': ${JSON.stringify(start)}`);
  const store = new FsJourneyStore(opts.journeysDir);
  if ((await store.get(id)) !== null) throw new DemoExistsError(`journey '${id}' already exists — pick another --id (nothing was changed)`);
  const recordPath = demoDraftPath(opts.journeysDir, id);
  if (existsSync(recordPath)) {
    throw new DemoExistsError(`a demo draft '${id}' is waiting for approval (${recordPath}) — approve it with \`jevitate demo approve ${id}\`, or pick another --id`);
  }
  const maxReplays = opts.maxReplays ?? DEMO_MINIMIZE_MAX_REPLAYS;
  const now = opts.now ?? (() => clock.nowIso());
  const base = { id, aspect, environment: env.name ?? env.baseUrl };

  const work = await mkdtemp(join(tmpdir(), "jevitate-demo-aspect-"));
  try {
    // 1. Explore and author (never promoted), into a scratch store.
    const authored = await runAuthorJourney({
      url: new URL(start, env.baseUrl).toString(),
      goal: aspect,
      successAssertion: opts.successAssertion,
      allowlist: env.allowedOrigins,
      journeysDir: join(work, "explored"),
      // #369: the discovery take's own artifacts stay in the scratch dir with the rest.
      outDir: join(work, "explored-runs"),
      journeyId: id,
      journeyName: aspect,
      takes: 1,
      judge: opts.judge,
      gen: opts.gen,
      ...(opts.bounds === undefined ? {} : { bounds: opts.bounds }),
      ...(opts.safety === undefined ? {} : { safety: opts.safety }),
      ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
      ...(quietBrowser(opts.browser) === undefined ? {} : { browser: quietBrowser(opts.browser) }),
      ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
      ...(opts.authorImpl === undefined ? {} : { authorImpl: opts.authorImpl }),
    });
    if (authored.outcome !== "authored") return { ...base, outcome: "not-reached", reason: authored.reason };

    const metadata: Journey["metadata"] = {
      ...authored.journey.metadata,
      promoted: false,
      goal: aspect,
      ...(opts.persona === undefined ? {} : { persona: opts.persona }),
      successCriteria: [{ description: `The success check holds: ${opts.successSpec}`, check: opts.successAssertion }],
    };
    // 2. Clean path: every candidate replays in its own scratch store, ending on the success check.
    const scratch = new FsJourneyStore(join(work, "candidates"));
    const replayOk = async (recording: Recording): Promise<boolean> => {
      await scratch.put({ metadata, recording: withSuccessAssert(recording, opts.successAssertion) });
      const run = await runJourneyProgrammatically({ dir: join(work, "candidates"), id, params: {}, ...replayOpts(opts) });
      return run.outcome === "ok";
    };
    const explored = withoutSuccessAssert(authored.journey.recording, opts.successAssertion);
    if (!(await replayOk(explored))) {
      return { ...base, outcome: "not-replayable", reason: "the explored path did not replay to its success check — nothing was written" };
    }
    let replays = 0;
    let budgetExhausted = false;
    const minimized = await minimizeRecording(explored, async (candidate) => {
      if (replays >= maxReplays) {
        budgetExhausted = true;
        return false;
      }
      replays += 1;
      return replayOk(candidate);
    });
    if (!(await replayOk(minimized))) {
      return { ...base, outcome: "not-replayable", reason: "the minimized path did not replay to its success check — nothing was written" };
    }
    const kept = new Set(minimized.pages.flatMap((p) => p.steps));
    const exploredFlat = explored.pages.flatMap((p) => p.steps);
    const minimize: DemoMinimizeReport = {
      exploredSteps: exploredFlat.length + 1,
      keptSteps: kept.size + 1,
      dropped: exploredFlat.filter((s) => !kept.has(s)).map((s) => describeStep(s.step)),
      replays,
      budgetExhausted,
    };
    const recording = withSuccessAssert(minimized, opts.successAssertion);
    const journey: Journey = { metadata: { ...metadata, params: deriveParamSchema(recording).required, createdAtIso: now() }, recording };

    // 3. Annotate (#246) and 4. draft the demo (#248) — both against a scratch store holding only this Journey.
    const stageDir = join(work, "stage");
    await new FsJourneyStore(stageDir).put(journey);
    const annotated = await annotateJourney({ dir: stageDir, id, params: {}, gen: opts.gen, now, ...replayOpts(opts) });
    if (annotated.replay.outcome !== "completed") {
      return { ...base, outcome: "stale", minimize, reason: `the annotation replay stopped: ${annotated.replay.reason ?? "unknown"} — nothing was written` };
    }
    const { draft: annotations } = await readAnnotationDraft(stageDir, id);
    const demo = await renderDemo(stageDir, id, opts, annotations, true, opts.outDir);
    if (demo.outcome !== "ok") {
      return { ...base, outcome: "stale", minimize, reason: `the draft demo's replay stopped${demo.stoppedAtStep === undefined ? "" : ` at step ${demo.stoppedAtStep}`}: ${demo.reason ?? "unknown"} — nothing was written` };
    }

    // Every stage succeeded: the Journey (unpromoted), its annotation draft and the demo record land.
    await store.put(journey);
    const draftPath = annotationDraftPath(opts.journeysDir, id);
    await mkdir(dirname(draftPath), { recursive: true, mode: 0o700 });
    await writeFile(draftPath, `${JSON.stringify(annotations, null, 2)}\n`, { mode: 0o600 });
    const record: DemoDraft = {
      kind: "jevitate.demo.draft",
      version: 1,
      id,
      aspect,
      env: base.environment,
      ...(opts.persona === undefined ? {} : { persona: opts.persona }),
      journeyHash: annotations.journeyHash,
      createdAtIso: now(),
      draft: outputsOf(demo),
    };
    assertNoSecretInPayload(record, [], "demo draft record");
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

    return {
      ...base,
      outcome: "drafted",
      minimize,
      steps: stepsOf(applyAnnotationDraft(journey, annotations).journey),
      annotations: { draftPath, proposed: annotated.proposed },
      draft: record.draft,
      demoDraftPath: recordPath,
      next: `jevitate demo approve ${id}`,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function outputsOf(demo: DemoJourneyResult): { video?: string; subtitles?: string; guide?: string } {
  return {
    ...(demo.video === undefined ? {} : { video: demo.video }),
    ...(demo.subtitles === undefined ? {} : { subtitles: demo.subtitles }),
    ...(demo.guide === undefined ? {} : { guide: demo.guide }),
  };
}

/** One demo render (#248) of `id` in `dir`, narrated with `annotations`, into `outDir`. */
function renderDemo(dir: string, id: string, opts: DemoReplayOptions, annotations: AnnotationDraft, draft: boolean, outDir: string): Promise<DemoJourneyResult> {
  return demoJourney({
    dir,
    id,
    params: {},
    video: join(outDir, "demo.webm"),
    guide: join(outDir, "guide.md"),
    annotations,
    draft,
    environment: opts.environment,
    ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    ...(opts.emulation === undefined ? {} : { emulation: opts.emulation }),
    ...(opts.siteGate === undefined ? {} : { siteGate: opts.siteGate }),
    ...(opts.fixtures === undefined ? {} : { fixtures: opts.fixtures }),
    ...(opts.paceMs === undefined ? {} : { paceMs: opts.paceMs }),
    ...(opts.captureLayers === undefined ? {} : { captureLayers: opts.captureLayers }),
  });
}

export interface ApproveDemoOptions extends DemoReplayOptions {
  readonly journeysDir: string;
  readonly id: string;
  /** Where the final video/subtitles/guide go (a folder). */
  readonly outDir: string;
  /** #433: the catalog's directory (personas.json, jobs.json); undefined: the project's `.jevitate/`. */
  readonly catalogDir?: string | null;
  /** #433: `--accept-unvetted "<reason>"` — approve although the Journey's linked job/persona is not approved. */
  readonly acceptUnvetted?: string;
  /** #433: `--accept-findings "<reason>"` — acknowledge pre-approval findings that need it. */
  readonly acceptFindings?: string;
}

export interface ApproveDemoResult {
  readonly id: string;
  /** `approved`: promoted, annotated, final demo rendered. `stale`: the final render's replay stopped — nothing promoted. */
  readonly outcome: "approved" | "stale";
  readonly reason?: string;
  readonly environment: string;
  /** The Journey as approved (steps with their annotations). */
  readonly steps: NonNullable<DemoAspectResult["steps"]>;
  /** What approving wrote into the Journey. */
  readonly changes: AnnotationChange[];
  readonly promoted: boolean;
  /**
   * #401: the assertion-strength errors the approval waived. A demo Journey shows a flow rather than
   * proving an outcome, so approving the demo is the reviewer's `--accept-weak`; the waiver is recorded
   * on the Journey (`metadata.acceptedWeak`) and listed here.
   */
  readonly acceptedWeak?: readonly string[];
  readonly final?: { readonly video?: string; readonly subtitles?: string; readonly guide?: string };
}

/** Reads what `demo approve <id>` would approve (the Journey, its draft annotations, the record) — refusals are typed. */
export async function loadDemoForApproval(journeysDir: string, id: string): Promise<{ record: DemoDraft; journey: Journey; annotations: AnnotationDraft }> {
  if (!DEMO_ID.test(id)) throw new DemoAspectArgsError(`not a demo id: ${JSON.stringify(id)}`);
  const { record } = await readDemoDraft(journeysDir, id);
  const journey = await new FsJourneyStore(journeysDir).get(id);
  if (journey === null) throw new UnknownJourneyError(`unknown journey '${id}' (its demo draft is at ${demoDraftPath(journeysDir, id)})`);
  const { draft: annotations, draftPath } = await readAnnotationDraft(journeysDir, id);
  if (journeyContentHash(journey) !== annotations.journeyHash) {
    throw new StaleAnnotationDraftError(`journey '${id}' changed after its demo was drafted (${draftPath}) — make the demo again`);
  }
  return { record, journey, annotations };
}

/**
 * The one human approval (#249): renders the FINAL demo (no DRAFT marks) with the reviewed
 * annotations; only when it replays does it apply the annotations, promote the Journey and remove
 * the demo record. A stale replay promotes nothing (outcome `stale`).
 */
/** #401: the reason recorded when a demo approval waives the assertion-strength lint. */
const DEMO_APPROVAL_WAIVER = "approved as a demo (jevitate demo approve)";

export async function approveDemo(opts: ApproveDemoOptions): Promise<ApproveDemoResult> {
  assertDemoEnvironment(opts.environment);
  const { journey, annotations } = await loadDemoForApproval(opts.journeysDir, opts.id);
  const environment = opts.environment.name ?? opts.environment.baseUrl;
  const annotated = applyAnnotationDraft(journey, annotations);
  const steps = stepsOf(annotated.journey);
  // #433: the catalog gate and the pre-approval findings, BEFORE the final render — the same gate
  // `promoteJourney` applies again when it promotes (a refusal here renders and changes nothing).
  const catalogDir = opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir;
  const gate = {
    catalogDir,
    ...(opts.acceptUnvetted === undefined ? {} : { acceptUnvetted: opts.acceptUnvetted }),
    ...(opts.acceptFindings === undefined ? {} : { acceptFindings: opts.acceptFindings }),
  };
  await journeyCatalogGate(annotated.journey, { ...gate, journeysDir: opts.journeysDir, action: "demo approve" });
  const demo = await renderDemo(opts.journeysDir, opts.id, opts, annotations, false, opts.outDir);
  if (demo.outcome !== "ok") {
    return {
      id: opts.id,
      outcome: "stale",
      reason: `the final demo's replay stopped${demo.stoppedAtStep === undefined ? "" : ` at step ${demo.stoppedAtStep}`}: ${demo.reason ?? "unknown"} — nothing was promoted`,
      environment,
      steps,
      changes: [],
      promoted: false,
    };
  }
  const applied = await approveJourneyAnnotations(opts.journeysDir, opts.id);
  const promotedJourney = await promoteJourney(opts.journeysDir, opts.id, { acceptWeak: DEMO_APPROVAL_WAIVER, ...gate, action: "demo approve" });
  const waived = promotedJourney.metadata.acceptedWeak?.rules;
  await rm(demoDraftPath(opts.journeysDir, opts.id), { force: true });
  return {
    id: opts.id,
    outcome: "approved",
    environment,
    steps,
    changes: applied.changes,
    ...(waived === undefined ? {} : { acceptedWeak: waived }),
    promoted: true,
    final: outputsOf(demo),
  };
}
