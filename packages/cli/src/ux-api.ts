// ux-api.ts — the CLI layer over @jevitate/ux. Two surfaces:
//   - runUxReview(): offline analysis over a saved Recording (`jevitate ux`).
//   - runUsabilityMission(): live analysis during an exploration
//     (`explore --strategy usability`) — reuses explore()'s loop via the
//     additive onSnapshot hook, collects evidence per screen, and analyzes
//     ONCE post-run (proper batching/budget; no model calls slow the browser).
//
// This is the ONLY place @jevitate/ux meets @jevitate/explore — the dep
// direction stays ux ⟂ explore (both are consumed here, neither imports the
// other). Findings are advisory; a UX finding never gates a run.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import {
  explore,
  assertAuthorizedExploreTarget,
  resolveMissionFixture,
  type Snapshot,
  type Control as ExploreControl,
  type Bounds,
} from "@jevitate/explore";
import {
  UxAnalyzer,
  a11yChecks,
  buildReport,
  loadV1Rubric,
  type AppContext,
  type Control as UxControl,
  type ScreenRef,
  type UxEvidence,
  type UxReport,
} from "@jevitate/ux";
import { resolveDataDir } from "./data-dir.js";

const DEFAULT_JUDGMENT_BUDGET = 40;

function emptyBehavior() {
  return { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 } as const;
}

/** explore's live `Control` → ux `Control` (same shape by design; drop `stability`). */
function toUxControl(c: ExploreControl): UxControl {
  return {
    index: c.index,
    role: c.role,
    name: c.name,
    tag: c.tag,
    inputType: c.inputType,
    enabled: c.enabled,
    summary: c.summary,
    descriptor: c.descriptor,
  };
}

/** a11y facts computable from a live snapshot's controls (honest subset). */
function a11yFactsFromControls(controls: readonly UxControl[]) {
  return {
    controls: controls.map((c) => ({
      controlRef: `control:${c.index}`,
      accessibleName: c.name.trim().length > 0 ? c.name : null,
      focusOrder: c.index,
      targetSize: null,
      contrastRatio: null,
    })),
  };
}

/** A live Snapshot (+ extracted page text) → one screen's UxEvidence. */
export function snapshotToEvidence(
  snap: Snapshot,
  visibleText: string,
  appContext: AppContext,
  job: string | undefined,
  history: readonly ScreenRef[],
): UxEvidence {
  const controls = snap.controls.map(toUxControl);
  return {
    screenId: snap.signature,
    url: snap.url,
    controls,
    visibleText,
    appContext,
    ...(job !== undefined ? { job } : {}),
    history,
    behavior: emptyBehavior(),
    a11yFacts: a11yFactsFromControls(controls),
  };
}

function descriptorSummary(d: TargetDescriptor): string {
  const parts = [d.role, d.name ?? d.testId ?? d.text].filter((s): s is string => !!s);
  return parts.join(" ") || "control";
}

function stepTarget(step: Recording["pages"][number]["steps"][number]["step"]): TargetDescriptor | undefined {
  if ("target" in step && step.target) return step.target;
  return undefined;
}

/**
 * A saved Recording → per-page UxEvidence. A Recording is deterministic and
 * thin: it carries the CONTROLS the user touched (via each step's descriptor)
 * and the page url, but NOT the full visible text or a11y geometry. So offline
 * analysis is honestly partial — items needing `visibleText`/`a11yFacts` Skip,
 * and coverage reports it. (The live mode carries the rich per-screen snapshot.)
 */
export function recordingToEvidence(recording: Recording, appContext: AppContext, job?: string): UxEvidence[] {
  const screens: UxEvidence[] = [];
  const history: ScreenRef[] = [];
  for (let i = 0; i < recording.pages.length; i++) {
    const page = recording.pages[i];
    const controls: UxControl[] = [];
    let idx = 0;
    const seen = new Set<string>();
    for (const rs of page.steps) {
      const d = stepTarget(rs.step);
      if (!d) continue;
      const key = JSON.stringify(d);
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push({
        index: idx++,
        role: d.role ?? "",
        name: d.name ?? d.testId ?? d.text ?? "",
        tag: "",
        inputType: null,
        enabled: true,
        summary: descriptorSummary(d),
        descriptor: d,
      });
    }
    const screenId = `${page.url}#${i}`;
    screens.push({
      screenId,
      url: page.url,
      controls,
      visibleText: "",
      appContext,
      ...(job !== undefined ? { job } : {}),
      history: [...history],
      behavior: emptyBehavior(),
      a11yFacts: { controls: [] },
    });
    history.push({ screenId, url: page.url });
  }
  return screens;
}

// ---------- Offline: `jevitate ux <recording>` ----------

export interface RunUxReviewOptions {
  readonly recording: Recording;
  readonly appContext: AppContext;
  readonly judge: JudgmentPort;
  readonly secrets?: readonly string[];
  /** Local file the `upload` op attaches (CLI `--fixture`); validated before any browser opens. */
  readonly fixture?: string;
  readonly judgmentBudget?: number;
  /** Where to write the report. Default `~/.jevitate/ux-reports`. */
  readonly outDir?: string;
  readonly nowIso?: () => string;
}

export interface RunUxReviewResult {
  readonly report: UxReport;
  readonly reportPath: string;
}

/**
 * Offline UX review. FAIL-FAST: an analyzer `failed` outcome throws
 * `UxAnalysisFailedError` (the CLI maps it to a non-zero fail envelope) — never
 * a fabricated "clean" report.
 */
export async function runUxReview(opts: RunUxReviewOptions): Promise<RunUxReviewResult> {
  const analyzer = new UxAnalyzer({ judge: opts.judge, a11yChecker: a11yChecks });
  const screens = recordingToEvidence(opts.recording, opts.appContext, opts.appContext.job);
  const outcome = await analyzer.analyze({
    screens,
    rubric: loadV1Rubric(),
    appContext: opts.appContext,
    secrets: opts.secrets,
    judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
  });
  if (outcome.kind === "failed") {
    throw new UxAnalysisFailedError(outcome.reason, outcome.screenId, outcome.rubricItemId);
  }
  const report = buildReport(outcome);
  const outDir = opts.outDir ?? resolveDataDir(["ux-reports"]);
  await mkdir(outDir, { recursive: true });
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const reportPath = join(outDir, `ux-${iso.replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath };
}

export class UxAnalysisFailedError extends Error {
  readonly code = "E_UX_ANALYSIS" as const;
  constructor(reason: string, readonly screenId?: string, readonly rubricItemId?: string) {
    super(`UX analysis failed: ${reason}${screenId ? ` (screen ${screenId})` : ""}`);
    this.name = "UxAnalysisFailedError";
  }
}

// ---------- Live: `explore --strategy usability` ----------

export interface RunUsabilityMissionOptions {
  readonly url: string;
  readonly job: string;
  readonly allowlist: readonly string[];
  readonly appContext: AppContext;
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /** Local file the `upload` op attaches (CLI `--fixture`); validated before any browser opens. */
  readonly fixture?: string;
  readonly judgmentBudget?: number;
  readonly outDir?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  readonly nowIso?: () => string;
  /** Test seam: extract a page's visible text. Default reads the live page. */
  readonly extractText?: (session: { page: { evaluate: (fn: () => string) => Promise<string> } }) => Promise<string>;
}

export interface RunUsabilityMissionResult {
  readonly report: UxReport;
  readonly reportPath: string;
  readonly stop: string;
  readonly screensObserved: number;
}

/**
 * Live usability mission. Guardrail #1 authorizes BEFORE opening a browser.
 * Reuses explore()'s loop (goal = the job) and, via the additive onSnapshot
 * hook, collects one screen's evidence per observation — then analyzes ONCE
 * after the run. A UX finding NEVER gates the loop (the hook's result is
 * ignored by explore). The temp profile dir is always removed.
 */
export async function runUsabilityMission(opts: RunUsabilityMissionOptions): Promise<RunUsabilityMissionResult> {
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  const fixture = opts.fixture === undefined ? undefined : await resolveMissionFixture(opts.fixture);
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const profileDir = await mkdtemp(join(tmpdir(), "jevitate-usability-"));
  const session = await port.open({
    profileDir,
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
  });
  const collected: UxEvidence[] = [];
  const history: ScreenRef[] = [];
  const extract =
    opts.extractText ??
    (async (s: { page: { evaluate: (fn: () => string) => Promise<string> } }) =>
      s.page.evaluate(() => (typeof document !== "undefined" && document.body ? document.body.innerText : "")));
  try {
    const actor = CastActor.named("usability-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const run = await explore({
      actor,
      judge: opts.judge,
      gen: opts.gen,
      goal: opts.job,
      allowlist: opts.allowlist,
      startUrl: opts.url,
      bounds: opts.bounds,
      secrets: opts.secrets,
      site: origin,
      fixture,
      missionContext:
        "usability review: pursue the stated job as a plausible first-time user, using only what is on screen",
      onSnapshot: async (snap) => {
        let visibleText = "";
        try {
          visibleText = await extract(session as never);
        } catch {
          visibleText = ""; // best-effort; the analyzer Skips visibleText items honestly
        }
        const ev = snapshotToEvidence(snap, visibleText, opts.appContext, opts.job, [...history]);
        collected.push(ev);
        history.push({ screenId: ev.screenId, url: ev.url });
      },
    });

    const analyzer = new UxAnalyzer({ judge: opts.judge, a11yChecker: a11yChecks });
    const outcome = await analyzer.analyze({
      screens: collected,
      rubric: loadV1Rubric(),
      appContext: opts.appContext,
      secrets: opts.secrets,
      judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
    });
    if (outcome.kind === "failed") {
      throw new UxAnalysisFailedError(outcome.reason, outcome.screenId, outcome.rubricItemId);
    }
    const report = buildReport(outcome);
    const outDir = opts.outDir ?? resolveDataDir(["ux-reports"]);
    await mkdir(outDir, { recursive: true });
    const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
    const reportPath = join(outDir, `usability-${iso.replace(/[:.]/g, "-")}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { report, reportPath, stop: run.stop, screensObserved: collected.length };
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}
