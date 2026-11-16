import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { describeStep, type Journey } from "@jevitate/journey";
import { ReadOnlyGuard, monitorFor } from "@jevitate/explore";
import { allowedOriginSet, offAllowlistWriteOrigin } from "./mcp-run-guard.js";
import { writeClassifier } from "@jevitate/recording";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { flattenRecording, retargetRecording, type ChangeScope, type JourneyHealOptions, type JourneyRunResult, type ProposedRevisionDraft, type SelfHealer, type SiteGateDeps } from "@jevitate/runtime";
import { runTagsOf, type RunPolicy } from "@jevitate/domain";
import type { RecordingInterpreter, StepObserver } from "@jevitate/interpreter";
import type { BrowserPort, BrowserSession, EmulationSpec } from "@jevitate/playwright";
import { captureStepScreenshot, type SecretPixelMask } from "./demo-capture.js";
import { currentDoneCheckScope } from "./journey-done-check-scope.js";
import { JourneyProposalProofError, writeJourneyProposal } from "./journey-proposal-store.js";
import { journeyResultRecord, type JourneyResultProposal } from "./journey-result-record.js";
import { logsDirFor } from "./project-dir.js";
import { recordRun } from "./run-index.js";
import { stampRunMetadata } from "./run-metadata.js";
import type { BoundSecretParams } from "./secret-params.js";
import type { BrowserRunOptions } from "./browser-run-options.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import type { JourneyRunRecorder } from "./journey-run-record.js";
import type { MissionFixtures } from "./mission-fixtures.js";
import type { SecretModeFlag } from "./journey-secret-mode.js";
import type { ScreenshotsSpec } from "./run-screenshots.js";

export interface RunJourneyProgrammaticallyOptions {
  /** Directory a `FsJourneyStore` reads Journey JSON files from. */
  dir: string;
  id: string;
  params: Record<string, string>;
  /** #788: decides on the stored Journey, right after it is read and before anything else: throws to refuse the run. */
  assertRunnable?: (stored: Journey) => Promise<void>;
  /** #789: the `targets.json` an MCP run's guard reads (default: `~/.jevitate/targets.json`). */
  runGuardTargetsFile?: string;
  /** #790: told what the run resolved to and watches its writes, for its value-free record. With it the run also writes its RunEvidence (#812). */
  runRecorder?: JourneyRunRecorder;
  /**
   * The secret parameters an operator's binding supplied (secret-params.ts) → where each may be
   * typed: its origins, or `allowlist` for this run's allowlist. Checked at type time.
   */
  boundSecretParams?: BoundSecretParams;
  /** 0.30.0 §5.3 `--secret-mode` (journey-secret-mode.ts): how a human step or a missing secret is met. Default `auto`. */
  secretMode?: SecretModeFlag;
  /** Where a target's `secretFields` `env:` sources are read (default: this process's environment). */
  secretEnv?: Readonly<Record<string, string | undefined>>;
  /** 0.30.0 §5.4: a hold's resume continues at this 1-based step; nothing before it runs again (journey-hold.ts). */
  resumeAtStep?: number;
  /** A resumed secret hold: the secret parameters a person types in the browser (journey-hold.ts). */
  heldSecretParams?: readonly string[];
  /** Told the run's `output` before it is redacted, for a caller that hands it on to a page (`journey chain`). Never reported. */
  onRawOutput?: (output: unknown) => void;
  /** Defaults to `safeRunPolicy()` (Slice 1: fail-closed secret mode) when omitted. */
  policy?: RunPolicy;
  /**
   * Optional gated self-heal port (Ticket #7). Only relevant when
   * `policy.selfHeal.mode !== "fail-closed"`; wired as the `JourneyRunner`'s
   * 5th constructor arg. When omitted (the default), a divergence quarantines
   * exactly as before — identical to Slice 1's fail-closed behavior. The
   * caller (CLI) is responsible for its credential preflight; this surface
   * never builds AI gateways itself. Writes never auto-heal regardless of
   * this port (enforced by `JourneyRunner`'s write floor).
   */
  selfHealer?: SelfHealer;
  /**
   * #453: the change context a `hybrid`/`full` self-heal is explained by (`readJourneyChangeScope`).
   * With it the runner gets the risky-control classification (`journeyStepRisk`) and a per-step write
   * blocker, so a guarded click/fill may be retargeted. Absent: every break is unexplained (never healed).
   */
  heal?: { readonly scope: ChangeScope };
  /**
   * Mission fixtures (#140/#144), built for the journey's own site once it is known: set up before
   * the browser opens (a failure throws `FixtureSetupError` — the journey never runs on unknown
   * state), `${setup.<name>}` in params bound to its outputs, and restored after the run.
   * `allowedOrigins` (#543): the replay's effective allowlist (site/environment ∪ the Journey's
   * `metadata.allowedOrigins` ∪ `--allow`) — what `journey run`/`verify` let a fixture reach, so a
   * fixture can reset an `http` check's source (a dev outbox) on an origin the human allowed.
   * `sourceSite` is the Journey's RECORDED site (before any environment rebase), from which
   * `fixtureRebaseUrl` finds the source environment's named origins (#561).
   */
  fixtures?: (site: string, allowedOrigins: readonly string[], sourceSite: string) => MissionFixtures | undefined;
  /**
   * Playwright storageState JSON to seed the session from (CLI/MCP `--storage-state`, #118) —
   * the deterministic authenticated pre-step a Journey authored behind a login needs to
   * replay. Contains live session cookies: handed only to the browser, never logged, never
   * returned in the result, and never sent to a model.
   */
  storageState?: string;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args) and shown (#245 demo mode). Default: pinned Chromium, headless. */
  browser?: BrowserRunOptions;
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`). */
  emulation?: EmulationSpec;
  /**
   * The site-policy gate's repositories (`jevitate site policy set`): pacing, throttles, budgets and
   * quiet hours for the Journey's origin. Absent (no policy database) means no site policy applies.
   */
  siteGate?: SiteGateDeps;
  /** The site-policy account (default `primary`, as `jevitate site policy` uses). */
  account?: string;
  /**
   * #246 seam: the interpreter the run replays with — `journey annotate` passes one carrying a
   * `StepObserver` (before/after page evidence). Default: a plain `RecordingInterpreter`.
   */
  interpreter?: RecordingInterpreter;
  /**
   * #488: the project root a relative `upload` fixture path resolves against (default: the parent
   * of the nearest `.jevitate/`, else the git root, else cwd). Testing seam.
   */
  fixtureBaseDir?: string;
  /**
   * The environment to run against (#247, `--env`/`--base-url`, from `resolveJourneyEnvironment`):
   * the Journey's recorded same-origin URLs move onto its `baseUrl` and the run's allowlist is its
   * `allowedOrigins`; a step on any other origin is refused before any fixture or browser.
   * Absent: the Journey's recorded site, exactly as before.
   */
  environment?: ResolvedJourneyEnvironment;
  /**
   * #542 (`--allow`): extra origins the replay may reach and block writes on, normalized. The
   * effective allowlist is the union of the recorded site (or the environment's origins), the
   * Journey's `metadata.allowedOrigins` and these.
   */
  allow?: readonly string[];
  /**
   * #251 `--screenshots`: one masked screenshot per distinct screen (or per step) + `index.md`;
   * the paths come back as `screenshotPaths`. Absent: none.
   */
  screenshots?: ScreenshotsSpec;
  /** #251 seam: a per-step observer composed into the default interpreter (annotate, demo). Ignored with `interpreter`. */
  observer?: StepObserver;
  /**
   * #250/#251: the run's pixel mask (default: one over the Journey's secret parameters) — installed
   * on the session before its first navigation whenever it records video or screenshots.
   */
  mask?: SecretPixelMask;
  /**
   * #293 journey-anchored exploration: replay in THIS already-open session and leave it open (the
   * caller's mission continues in the same page, form contents and session). No browser is opened
   * or closed here; video/screenshots belong to the caller's session.
   */
  session?: BrowserSession;
  /**
   * #293: replay only the first N top-level steps — the prefix up to an anchor. A `--param` the
   * Journey does not take is still refused; one only a later step uses is not required (and unused).
   */
  stopAfterStep?: number;
  /**
   * #303 `--action-deltas` (opt-in): record what each replayed step changed (redacted, code verdict)
   * and compare it with the delta the Journey's Recording stored — returned as `actionDeltas`.
   * Observation only: it never changes the replay. Off: nothing is captured.
   */
  actionDeltas?: boolean;
  /**
   * #486: how long (ms) a step's response check waits for a matching request that was sent but has no
   * response yet (a cold start). A late 2xx is an advisory `slowSteps` finding, never a quarantine.
   * Default 15000; a step's own `responseTimeoutMs` overrides it.
   */
  stepResponseTimeoutMs?: number;
}

/**
 * #402: how a mutation-proof replay (`journey verify --mutate`) differs from `journey run` — a
 * separate argument, never a surface option: no other caller passes it.
 */
export interface MutationReplayOptions {
  /** Internal verification boundary, while the final capture remains open. */
  beforeFinalNetworkCaptureClose?: () => Promise<void>;
  /** Internal mutation classifier policy; never a CLI/MCP authority override. */
  readRequests?: readonly string[];
  /** #708: declared proof only; original check indices/capture are preserved. Never a CLI/MCP flag. */
  relaxedStepRequests?: readonly string[];
  /**
   * #402 `journey verify --mutate`: replay a MUTATED copy of the Journey. Applied after params are
   * validated against the stored Journey (a mutation may stop a step reading a param), and never to
   * an anchored prefix. Indices must be kept: a mutation changes a step, never removes one.
   */
  mutateJourney?: (journey: Journey) => Journey;
  /** #402: leave this flat step (0-based) out of the replay — `RecordingInterpreter`'s `skipStep`. */
  skipStep?: (index: number) => boolean;
  /**
   * #579: a swap-param feeding a `select` selects a DIFFERENT enabled live option at this flat step
   * (0-based) instead of rewriting the param — `RecordingInterpreter`'s `selectAlternative`.
   */
  selectAlternativeAtStep?: { index: number; avoid: string };
  /**
   * #402: ABORT the write requests (the #110 classifier, first-party only — `ReadOnlyGuard`) that
   * start while this flat step (0-based) runs, until the network settles after it. Never answered,
   * never sent; what was blocked comes back as `blockedWrites`.
   */
  blockWritesAtStep?: number;
  /**
   * With `blockWritesAtStep`: these recorded write lines stay blocked for the rest of the replay, so a
   * client's retry of an aborted write cannot land later. `exemptSteps` (0-based) record the same line
   * as their own, so it goes through while they run.
   */
  blockAfterWindow?: { requests: readonly string[]; exemptSteps: readonly number[] };
  /** Mutation proof: runs first as each step ends, before anything that step goes on waiting for. */
  earliestObserver?: StepObserver;
  /** #402: also return the outcome checks' structured failures (`outcomeFailures`). */
  structuredFailures?: boolean;
  /** Mutation proof: awaited just before the end state's checks start. */
  beforeEndState?: () => Promise<void>;
  /** Mutation proof: called as the end state's checks end. They settle first, so only this shows when the base replay read it. */
  afterEndState?: () => void;
  /** A proof must not trust a replay after a failed restore. Called once the run's restore has ended, however the run ended. */
  onFixtureRestoreFailed?: () => void;
  /**
   * Told every secret the replay knows (its secret params, a vault or targets.json binding, a fixture's
   * secret outputs, an extracted credential) once the replay ends, however it ended, so a proof's own
   * report redacts them too (independent check M6). Never reported.
   */
  onRunSecrets?: (secrets: readonly string[]) => void;
}

/** #453: what a self-heal run adds to its result — the proposal it wrote and the persisted result file. */
export interface HealRunFields {
  proposal?: JourneyResultProposal & { reviewCommand: string; acceptCommand: string };
  resultPath?: string;
}

/**
 * #485: records each distinct origin outside `allowedOrigins` that the session's context sent a
 * write (any method but GET/HEAD/OPTIONS) to. A replay never blocks them; this only observes.
 * A session whose page has no context events (a test double) observes nothing.
 */
export function watchOffAllowlistWrites(session: BrowserSession, allowedOrigins: readonly string[]): { stop(): string[] } {
  const allowed = allowedOriginSet(allowedOrigins);
  const seen: string[] = [];
  const onRequest = (request: { method(): string; url(): string }): void => {
    const origin = offAllowlistWriteOrigin(request.method(), request.url(), allowed);
    if (origin !== undefined && !seen.includes(origin)) seen.push(origin);
  };
  const page = session.page as Partial<Page> | undefined;
  const context = typeof page?.context === "function" ? page.context() : undefined;
  if (context === undefined || typeof context.on !== "function") return { stop: () => [...seen] };
  context.on("request", onRequest);
  let stopped = false;
  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        context.off("request", onRequest);
      }
      return [...seen];
    },
  };
}

/** The heal probe's evidence: a masked screenshot of the page after each candidate, under `<logs>/journey-<id>-<stamp>.heal/`. */
export function healObserver(dir: string, mask: SecretPixelMask): NonNullable<JourneyHealOptions["observe"]> {
  return async (actor, at) => {
    const page = actor.ability(BrowseTheWebToken).session.page;
    await mkdir(dir, { recursive: true });
    const path = join(dir, `step-${at.stepIndex + 1}-attempt-${at.attempt}.png`);
    await captureStepScreenshot(page, path, { step: at.stepIndex }, [mask.layer()]);
    return { screenshot: path };
  };
}

/**
 * #453: writes the proposal of a `healed-pending-review` run (the stored Journey is never written)
 * and the run's `journey-<id>-<stamp>.result.json` (recorded in the run index). Returns the result
 * to report and the fields to put on it: the `proposal` handle, the `resultPath`.
 *
 * A run on an environment (`--env` / `--base-url`) proposes against the STORED Journey: a retarget
 * changes a target or a navigate path, and a navigate URL moved onto the environment's base URL is
 * moved back onto the recorded site. Where no proposal can be written (`unwritable`: a prefix or
 * mutated replay; or a revision the proof check refuses) the run is NOT pending review — there is
 * nothing to accept — it is reported `quarantined`, its reason saying why no proposal was written.
 * A `healed-pending-review` result never leaves here without a proposal id.
 */
export async function persistHealRun(a: {
  result: JourneyRunResult;
  stored: Journey;
  params: Record<string, string>;
  secrets: readonly string[];
  opts: RunJourneyProgrammaticallyOptions;
  stampBase: string;
  startedAt: string;
  unwritable?: string;
}): Promise<{ result: JourneyRunResult; fields: { proposal?: JourneyResultProposal & { reviewCommand: string; acceptCommand: string }; resultPath: string } }> {
  const resultPath = join(logsDirFor(a.startedAt), `${a.stampBase}.result.json`);
  const id = a.opts.id;
  let result = a.result;
  let proposal: (JourneyResultProposal & { reviewCommand: string; acceptCommand: string }) | undefined;
  if (result.outcome === "healed-pending-review") {
    let why: string | undefined = a.unwritable ?? (result.heal === undefined ? "the run carries no heal record" : undefined);
    if (why === undefined && result.heal !== undefined) {
      const scope = a.opts.heal?.scope;
      try {
        const draft = draftOnStored(a.stored, result.revision, a.opts.environment);
        const written = await writeJourneyProposal(a.opts.dir, {
          journeyId: id,
          base: a.stored,
          draft,
          attempts: result.heal.attempts,
          changes: {
            ...(scope?.range === undefined ? {} : { range: scope.range }),
            ...(scope?.baseSha === undefined ? {} : { baseSha: scope.baseSha }),
            ...(scope?.headSha === undefined ? {} : { headSha: scope.headSha }),
            notes: (scope?.evidence ?? []).flatMap((e) => (e.kind === "note" && e.note !== undefined ? [e.note] : [])),
          },
          runResultPath: resultPath,
          secrets: a.secrets,
        });
        proposal = {
          id: written.proposalId,
          path: written.path,
          steps: draft.steps.map((c) => ({ number: c.index + 1, before: describeStep(c.before), after: describeStep(c.after) })),
          reviewCommand: `jevitate journey review ${id}`,
          acceptCommand: `jevitate journey promote ${id} --proposal ${written.proposalId}`,
        };
      } catch (err) {
        // A revision that touches proof (or fails the heal floor) is never stored.
        if (!(err instanceof JourneyProposalProofError)) throw err;
        why = err.message;
      }
    }
    if (proposal === undefined) {
      result = {
        outcome: "quarantined",
        reason: `the run completed only after a heal, but no proposal was written (${why ?? "unknown"}) — there is nothing to accept; re-run on the recorded site without a prefix or mutation`,
        ...(result.waits === undefined ? {} : { waits: result.waits }),
        ...(result.heal === undefined ? {} : { heal: result.heal }),
      };
    }
  }
  // H5: the record keeps the run's job verdict (its done-check scope's) and folds it into the exit.
  const doneCheck = currentDoneCheckScope();
  const record = journeyResultRecord(result, { journey: a.stored, params: a.params, startedAt: a.startedAt, ...(proposal === undefined ? {} : { proposal }), ...(doneCheck?.job === undefined ? {} : { job: doneCheck.job, doneCheckPolicy: doneCheck.policy }) });
  const stamped = { ...record, result: stampRunMetadata(record.result) };
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  recordRun(resultPath, { tags: runTagsOf(stamped.result) });
  return { result, fields: { ...(proposal === undefined ? {} : { proposal }), resultPath } };
}

/**
 * The revision a run on an environment proposed, onto the STORED Journey: each changed step's
 * `before` is the stored step, its `after` the retarget — a navigate URL on the environment's base
 * URL moved back onto the recorded site. Without an environment the draft is the stored Journey's.
 */
export function draftOnStored(stored: Journey, draft: ProposedRevisionDraft, env: ResolvedJourneyEnvironment | undefined): ProposedRevisionDraft {
  if (env === undefined) return draft;
  let recordedOrigin: string | undefined;
  try {
    recordedOrigin = /^https?:\/\//i.test(stored.recording.site) ? new URL(stored.recording.site).origin : undefined;
  } catch {
    recordedOrigin = undefined;
  }
  const base = env.baseUrl.replace(/\/+$/, "");
  const unbase = (url: string): string => {
    if (recordedOrigin === undefined || !url.startsWith(base)) return url;
    const rest = url.slice(base.length);
    return rest === "" || /^[/?#]/.test(rest) ? `${recordedOrigin}${rest}` : url;
  };
  const flat = flattenRecording(stored.recording);
  let recording = stored.recording;
  const steps = draft.steps.map((c) => {
    const before = flat[c.index]?.step;
    if (before === undefined) throw new JourneyProposalProofError(`the revision changes step ${c.index + 1}, which the stored Journey does not have`);
    // #467: the index must still name the step that was healed.
    const storedId = flat[c.index]?.recorded.stepId;
    if (c.stepId !== undefined && storedId !== c.stepId) {
      throw new JourneyProposalProofError(`the revision changes step ${c.index + 1} (${c.stepId}), but the stored Journey's step ${c.index + 1} is ${storedId ?? "(no id)"}`);
    }
    // A target is environment-independent; only an absolute navigate URL was moved (rebaseRecording).
    const after = c.after.kind === "navigate" ? { ...c.after, url: unbase(c.after.url) } : c.after;
    recording = retargetRecording(recording, c.index, after);
    return { ...c, before, after };
  });
  return { recording, steps };
}

/** How long one blocked step's window stays open for the writes its action triggers (network settle). */
const BLOCK_WINDOW_SETTLE_MS = 5_000;

/**
 * A write on a held line that got an answer, by `line`. A response is the answer: Chromium may never
 * report the end of a body the page does not read, and a write the server answered did not stay blocked.
 */
export function watchEscapedWrites(
  context: { on(event: "request" | "response", listener: (arg: never) => void): unknown },
  lineIfHeld: (r: { method(): string; url(): string }) => string | undefined,
): () => string[] {
  const sent = new Map<unknown, string>();
  const escaped = new Set<string>();
  context.on("request", ((r: { method(): string; url(): string }) => {
    const line = lineIfHeld(r);
    if (line !== undefined) sent.set(r, line);
  }) as (arg: never) => void);
  context.on("response", ((res: { request(): unknown }) => {
    const line = sent.get(res.request());
    if (line !== undefined) escaped.add(line);
  }) as (arg: never) => void);
  return () => [...escaped];
}

/**
 * #402 block-write: a `ReadOnlyGuard` armed on the page whose action window is the given step — opened
 * as it begins, closed once the network settled after it. Every held write is aborted (a write
 * navigation too: never answered with a status that could read as a success). The step's own lines
 * stay blocked after the window (`blockAfterWindow`). What the guard's page route cannot reach is watched
 * on the context: a matching write answered after the window means the mutation did not hold.
 */
export async function stepWriteBlocker(
  page: Page,
  index: number,
  allowedOrigins: readonly string[],
  after: MutationReplayOptions["blockAfterWindow"],
  readRequests?: readonly string[],
): Promise<{ guard: ReadOnlyGuard; observer: StepObserver; escaped: () => string[] }> {
  const guard = new ReadOnlyGuard(writeClassifier(readRequests === undefined ? {} : { readRequests }), { allowlist: [...allowedOrigins], navigationWrites: "abort" });
  await guard.arm(page);
  const monitor = monitorFor(page);
  await monitor.instrument();
  let held: ReadonlySet<string> = new Set();
  let released = false;
  const lineOf = (r: { method(): string; url(): string }): string | undefined => {
    try {
      return `${r.method().toUpperCase()} ${new URL(r.url()).pathname}`;
    } catch {
      return undefined;
    }
  };
  const context = typeof page.context === "function" ? page.context() : undefined;
  const escaped =
    after !== undefined && typeof context?.on === "function"
      ? watchEscapedWrites(context as never, (r) => {
          const line = lineOf(r);
          return !released && line !== undefined && held.has(line) ? line : undefined;
        })
      : () => [];
  return {
    guard,
    escaped,
    observer: {
      beforeStep: async ({ index: i }) => {
        if (i === index) guard.beginAction();
        if (after?.exemptSteps.includes(i) === true) {
          released = true;
          guard.releaseHeldLines(true);
        }
      },
      afterStep: async ({ index: i }) => {
        if (after?.exemptSteps.includes(i) === true) {
          released = false;
          guard.releaseHeldLines(false);
        }
        if (i !== index) return;
        try {
          await monitor.waitSettled({ ceilingMs: BLOCK_WINDOW_SETTLE_MS });
        } finally {
          guard.settled();
          if (after !== undefined) held = guard.holdLines(after.requests);
        }
      },
    },
  };
}
