import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { withRunTriage, type RunTriage } from "./explore-shared.js";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertNoSecretInPayload, redactText, redactUrl } from "@jevitate/ai-core";
import { fileDraft, fingerprintMarker, targetsFor, type FilingConfig, type FilingOutcome, type IssueDraft, type IssueFilerPort, clock } from "@jevitate/domain";
import {
  DemoOverlay,
  PageSignalCollector,
  assertAuthorizedExploreTarget,
  monitorFor,
  observeAfterStep,
  perceive,
  signalFingerprint,
} from "@jevitate/explore";
import { RecordingInterpreter, type StepObserver } from "@jevitate/interpreter";
import { describeStep } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import type { Recording, RecordedStep, TargetDescriptor } from "@jevitate/recording";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { captureStepScreenshot, maskingPort, SecretPixelMask } from "./demo-capture.js";
import type { RunScreenshots } from "./run-screenshots.js";
import { findFinding, parsePersistedMission } from "./verify-fix-api.js";
import { writeIssueDrafts } from "./findings-filing.js";

/**
 * #250 — defect evidence: per defect, its minimal repro Recording (the one `verify-fix` replays:
 * the finding's own, else the run's, up to `repro.recordingStepIndex`) is replayed in a FRESH
 * session with the demo overlay and a video. Each step is captioned with what it does (its
 * objective, else its label, else a value-free description); the failing step is marked with the
 * defect's actual signal ("Save → server returned 500 (PUT /api/profile)", "invariant `x`
 * violated", …) and whether this replay saw it fire again. Two key screenshots — just before the
 * failing step and at it, the failing element highlighted — have the overlay hidden.
 *
 * Secrets are masked in pixels by the display-only mask layer (`demo-capture.ts`) from the video's
 * first paint; the mask is re-proven at every step. FAIL CLOSED: a clip whose mask could not be
 * proven at some step is deleted and the reason recorded; a screenshot that cannot be proven is not
 * written. Nothing here reaches a model; every string written is redacted.
 *
 * The media are attached as `defects[].evidence.{videoPath, screenshots[]}` (additive, schemaVersion
 * 1), appended to the defect's issue draft, and read by `report` / `check` (JUnit, SARIF). GitHub's
 * API cannot upload media: drafts and filed issues LINK to the files (commit them under `.jevitate/`
 * or publish them as CI artifacts).
 */

/** Caption time per step in an evidence clip (ms). */
export const EVIDENCE_PACE_MS = 700;
/** At most this many defects get a clip per run (hard defects first). */
export const EVIDENCE_MAX_DEFECTS = 5;

export interface DefectEvidence {
  /** The captioned repro clip (WebM). Absent: no video was asked for, or it was refused (see `skipped`). */
  readonly videoPath?: string;
  /** Key screenshots: just before the failing step, and at it (failing element highlighted). */
  readonly screenshots: string[];
  /** 1-based failing step within the repro. */
  readonly failingStep?: number;
  /** What the failing step is marked with (redacted). */
  readonly signal?: string;
  /** Whether the defect's signal fired again on this replay (absent when the replay cannot tell). */
  readonly reproduced?: boolean;
  /** How the replay went: `completed`, or where it stopped. */
  readonly replay?: { readonly outcome: "completed" | "stopped"; readonly atStep?: number; readonly reason?: string };
  /** Why there is no media at all (no repro Recording, the session could not be masked, …). */
  readonly skipped?: string;
  /** Captures refused (fail closed) with their reason. */
  readonly captureSkips?: string[];
}

export interface EvidenceReplayInput {
  readonly recording: Recording;
  /** Flat index of the failing step (the defect's `repro.recordingStepIndex`). */
  readonly stepIndex: number;
  /** The defect's fingerprint(s): a page signal with one of them means it fired again. */
  readonly fingerprints: readonly string[];
  /** Whether a page signal can show this defect at all (else `reproduced` stays absent). */
  readonly signalCheckable: boolean;
  /** The failing step's mark (redacted by the caller). */
  readonly signal: string;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly storageState?: string;
  readonly emulation?: EmulationSpec;
  /** Where the clip and screenshots go (created). */
  readonly outDir: string;
  /** Record the clip (else screenshots only). */
  readonly video: boolean;
  /** #251: the run's `--screenshots` capture, fed after every step. */
  readonly screenshots?: RunScreenshots;
  readonly secrets: readonly string[];
  readonly browser?: BrowserRunOptions;
  readonly browserPortFactory?: () => BrowserPort;
  readonly paceMs?: number;
  readonly settleCeilingMs?: number;
  /** The final card (e.g. verify-fix's verdict); default: reproduced / not reproduced. */
  readonly finalCard?: (reproduced: boolean | undefined) => { readonly text: string; readonly ok: boolean };
}

const sleep = (ms: number): Promise<void> => clock.sleep(ms);

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cut(s: string, n: number): string {
  const t = oneLine(s);
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unknown error";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A recorded step's caption: its objective, else its label, else a value-free description. */
export function stepCaption(recorded: RecordedStep): string {
  const pick = [recorded.objective, recorded.step.label].map((t) => (t ?? "").trim()).find((t) => t !== "");
  return oneLine(pick ?? describeStep(recorded.step));
}

function targetOf(recorded: RecordedStep | undefined): TargetDescriptor | null {
  const step = recorded?.step as { target?: TargetDescriptor } | undefined;
  return step?.target ?? null;
}

/** Kinds whose fingerprint is a page signal's (`signalFingerprint`): a replay can see them fire again. */
const SIGNAL_KINDS = new Set(["http-5xx", "console-error", "page-error", "failed-request"]);

/** Whether a replay's page signals can show a defect of this kind fire again. */
export function signalCheckable(kind: string): boolean {
  return SIGNAL_KINDS.has(kind);
}

/** The persisted defect (or hang) record with this fingerprint in a raw `<stem>.result.json`. */
export function persistedDefect(raw: unknown, fingerprint: string): Record<string, unknown> | undefined {
  const result = isRecord(raw) && isRecord(raw.result) ? raw.result : undefined;
  // `serverLogDefects` is no longer written (removed in 0.3.0); read it so older results still resolve.
  for (const list of [result?.defects, result?.hangs, result?.serverLogDefects]) {
    if (!Array.isArray(list)) continue;
    const hit = list.filter(isRecord).find((d) => d.fingerprint === fingerprint || (Array.isArray(d.related) && d.related.includes(fingerprint)));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** What a defect's failing step is marked with: its actual signal, in one line (redacted). */
export function defectSignalText(d: Record<string, unknown>, secrets: readonly string[]): string {
  const kind = str(d.kind) ?? "defect";
  const signals = Array.isArray(d.signals) ? d.signals.filter(isRecord) : [];
  const own = signals.find((s) => s.kind === kind) ?? signals[0];
  // The request's method: the defect's own (goal/usability runners), else its signal's (adversarial).
  const method = str(d.method) ?? str(own?.method);
  let text: string;
  if (kind === "http-5xx") {
    const url = str(own?.url) ?? str(d.url) ?? "";
    const status = typeof own?.status === "number" ? own.status : undefined;
    text = `server returned ${status ?? "5xx"} (${method === undefined ? "" : `${method} `}${pathOf(url)})`;
  } else if (kind === "invariant") {
    const inv = isRecord(d.invariant) ? d.invariant : undefined;
    text = `invariant \`${str(inv?.id) ?? "?"}\` violated`;
  } else if (kind === "console-error") text = `console error: ${str(own?.detail) ?? str(d.title) ?? ""}`;
  else if (kind === "page-error") text = `uncaught page error: ${str(own?.detail) ?? str(d.title) ?? ""}`;
  else if (kind === "failed-request") text = `request failed (${pathOf(str(own?.url) ?? "")})`;
  else if (kind === "horizontal-overflow") text = `horizontal overflow${typeof own?.overflowPx === "number" ? ` (${own.overflowPx}px)` : ""}`;
  else if (kind === "vertical-clipping") text = `text cut off${typeof own?.clippedPx === "number" ? ` (${own.clippedPx}px)` : ""}`;
  else if (kind === "server-log") text = `server log error: ${str(d.title) ?? ""}`;
  else if (kind === "hang") text = `the page hung: ${str(d.title) ?? ""}`;
  else text = str(d.title) ?? kind;
  return cut(redactText(redactUrl(text), secrets), 160);
}

/**
 * Replays `recording` up to `stepIndex` with captions, the failing step marked, key screenshots and
 * (when `video`) a clip — see the module comment. Never throws: a failure is `skipped` / `captureSkips`.
 */
export async function replayWithEvidence(input: EvidenceReplayInput): Promise<DefectEvidence> {
  const secrets = input.secrets;
  const redact = (s: string): string => redactText(s, secrets);
  const flat = input.recording.pages.flatMap((p) => p.steps);
  const idx = Math.min(input.stepIndex, flat.length - 1);
  if (idx < 0) return { screenshots: [], skipped: "the repro Recording has no steps" };
  let origin: string;
  try {
    origin = assertAuthorizedExploreTarget(input.seedUrl, [...input.allowlist]);
  } catch (e) {
    return { screenshots: [], skipped: redact(errText(e)) };
  }
  if (input.storageState !== undefined && !existsSync(input.storageState)) {
    return { screenshots: [], skipped: "the run's storage state file is gone" };
  }
  await mkdir(input.outDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "jevitate-evidence-"));
  const mask = new SecretPixelMask(secrets);
  const base = (input.browserPortFactory ?? (() => new PlaywrightBrowserPort()))();
  const port = maskingPort(base, mask);
  const { recordVideo: _rv, ...shown } = input.browser ?? {};
  const pace = input.paceMs ?? EVIDENCE_PACE_MS;
  const screenshots: string[] = [];
  const captureSkips: string[] = [];
  let tainted: string | undefined;
  let session: Awaited<ReturnType<BrowserPort["open"]>>;
  try {
    session = await port.open({
      ...sessionLaunchOptions(shown, input.video ? work : undefined),
      allowedOrigins: [...input.allowlist],
      baseUrl: origin,
      ...input.emulation,
      ...(input.storageState === undefined ? {} : { storageState: input.storageState }),
    });
  } catch (e) {
    await rm(work, { recursive: true, force: true });
    return { screenshots: [], skipped: `could not open a masked session: ${redact(errText(e))}` };
  }
  const page = session.page;
  const overlay = new DemoOverlay(secrets);
  const fired = new Set<string>();
  let collector: PageSignalCollector | undefined;
  const drain = (): void => {
    for (const s of collector?.drain() ?? []) fired.add(signalFingerprint(s));
  };
  const reproducedNow = (): boolean | undefined => {
    drain();
    if (input.fingerprints.some((f) => fired.has(f))) return true;
    return input.signalCheckable ? false : undefined;
  };
  /** The video is only kept if the mask was proven at every step (fail closed). */
  const proveMask = async (): Promise<void> => {
    if (!input.video || !mask.active || tainted !== undefined) return;
    const r = await mask.verify(page);
    if (!r.ok) tainted = r.reason ?? "the mask could not be proven";
  };
  const shoot = async (moment: "before" | "at", step: number): Promise<void> => {
    const file = join(input.outDir, `${moment}-step-${step}.png`);
    try {
      await captureStepScreenshot(page, file, { step }, [mask.layer()]);
      screenshots.push(file);
    } catch (e) {
      captureSkips.push(`${moment} step ${step}: ${redact(errText(e))}`);
    }
  };
  let reproduced: boolean | undefined;
  const total = idx + 1;
  const observer: StepObserver = {
    beforeStep: async ({ index }) => {
      await proveMask();
      const recorded = flat[index];
      if (recorded === undefined) return;
      const caption = redact(stepCaption(recorded));
      if (index === idx) await shoot("before", index + 1);
      await overlay.caption(
        page,
        { head: `step ${index + 1} of ${total}${index === idx ? " · the failing step" : ""}`, text: caption },
        targetOf(recorded),
      );
      await sleep(pace);
    },
    afterStep: async ({ index, outcome }) => {
      await overlay.refresh(page);
      await proveMask();
      const recorded = flat[index];
      if (index === idx && recorded !== undefined) {
        // Let the async work the step started (the late 500, the deferred error) land first.
        await perceive(page, input.settleCeilingMs === undefined ? {} : { renderWaitMs: input.settleCeilingMs }).catch(() => undefined);
        reproduced = reproducedNow();
        const caption = redact(stepCaption(recorded));
        const mark =
          reproduced === false ? `${caption} → did not fire on this replay (the run saw: ${input.signal})` : `${caption} → ${input.signal}`;
        await overlay.caption(page, { head: `✗ step ${index + 1} of ${total} · the failing step`, text: mark });
        const target = targetOf(recorded);
        if (target !== null) await mask.highlight(page, target);
        await shoot("at", index + 1);
        await mask.clearHighlight(page);
        const card = input.finalCard?.(reproduced) ?? {
          text: reproduced === false ? `Did not reproduce on this replay: ${input.signal}` : `Defect: ${mark}`,
          ok: reproduced === false,
        };
        await overlay.card(page, card.text, card.ok ? "ok" : "bad");
        await sleep(pace);
        await proveMask();
      }
      await input.screenshots?.capture(page, {
        step: index + 1,
        what: `${recorded === undefined ? `step ${index + 1}` : stepCaption(recorded)}${outcome === "failed" ? " — failed" : ""}`,
      });
    },
  };
  let replay: DefectEvidence["replay"];
  try {
    collector = new PageSignalCollector(page, clock.now, input.allowlist);
    await monitorFor(page).instrument();
    const actor = CastActor.named("evidence").whoCan(new BrowseTheWeb(session, [...input.allowlist]));
    const r = await new RecordingInterpreter({ observer }).runToCheckpoint(actor, observeAfterStep(input.recording, idx), idx);
    replay =
      r.outcome === "completed"
        ? { outcome: "completed" }
        : {
            outcome: "stopped",
            atStep: r.at + 1,
            reason: cut(redact(r.outcome === "failed" ? r.error : "paused for a human hand-back"), 300),
          };
    if (r.outcome !== "completed" && r.at < idx) {
      await overlay.card(page, `The replay stopped at step ${r.at + 1} of ${total}: the recorded path no longer reproduces`, "bad");
      await sleep(pace);
    }
    await proveMask();
  } catch (e) {
    replay = { outcome: "stopped", reason: cut(redact(errText(e)), 300) };
  }
  const videoTmp = session.videoPath;
  await session.close().catch(() => undefined);
  let videoPath: string | undefined;
  if (input.video) {
    if (tainted !== undefined) captureSkips.push(`video: not kept — secret masking could not be proven (${redact(tainted)})`);
    else if (videoTmp === undefined || !existsSync(videoTmp)) captureSkips.push("video: the replay recorded no video");
    else {
      videoPath = join(input.outDir, "clip.webm");
      await copyFile(videoTmp, videoPath);
    }
  }
  await rm(work, { recursive: true, force: true });
  return {
    ...(videoPath === undefined ? {} : { videoPath }),
    screenshots,
    failingStep: idx + 1,
    signal: input.signal,
    ...(reproduced === undefined ? {} : { reproduced }),
    ...(replay === undefined ? {} : { replay }),
    ...(captureSkips.length === 0 ? {} : { captureSkips }),
  };
}

export interface AttachEvidenceOptions {
  /** The run's persisted `<stem>.result.json`. */
  readonly resultPath: string;
  /** Record a clip per defect (`--evidence-video`); screenshots are always taken. Default true. */
  readonly video?: boolean;
  /** Where evidence goes (default `<stem>.evidence/` beside the result); one folder per defect. */
  readonly dir?: string;
  /** Every registered secret of the run: masked in pixels, redacted in text. */
  readonly secrets?: readonly string[];
  /** Overrides the storage state recorded with the run. */
  readonly storageState?: string;
  readonly browser?: BrowserRunOptions;
  readonly browserPortFactory?: () => BrowserPort;
  readonly paceMs?: number;
  readonly maxDefects?: number;
  readonly settleCeilingMs?: number;
}

/** `<dir>/<stem>.result.json` → `<dir>/<stem>.evidence`. */
export function evidenceDirFor(resultPath: string): string {
  return join(dirname(resultPath), `${basename(resultPath).replace(/\.result\.json$/, "").replace(/\.json$/, "")}.evidence`);
}

/**
 * Captures evidence for a finished run's defects (hard ones first, at most `maxDefects`), writes it
 * into the persisted result (`defects[].evidence`) and the defects' issue drafts, and returns the
 * updated result. A run with no defects is returned unchanged (nothing replayed).
 */
export async function attachDefectEvidence<R extends object>(result: R, opts: AttachEvidenceOptions): Promise<R> {
  const r = result as unknown as Record<string, unknown>;
  const defects = Array.isArray(r.defects) ? r.defects.filter(isRecord) : [];
  if (defects.length === 0) return result;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.resultPath, "utf8"));
  } catch {
    return result; // no persisted result: nothing to replay from
  }
  const secrets = opts.secrets ?? [];
  let mission: ReturnType<typeof parsePersistedMission>;
  try {
    mission = parsePersistedMission(raw);
  } catch {
    return result;
  }
  const root = opts.dir ?? evidenceDirFor(opts.resultPath);
  const max = opts.maxDefects ?? EVIDENCE_MAX_DEFECTS;
  const order = [...defects].sort((a, b) => Number(a.advisory === true) - Number(b.advisory === true));
  const chosen = new Set(order.slice(0, max).map((d) => d.fingerprint));
  const byFp = new Map<string, DefectEvidence>();
  for (const d of defects) {
    const fp = str(d.fingerprint);
    if (fp === undefined) continue;
    if (!chosen.has(fp)) {
      byFp.set(fp, { screenshots: [], skipped: `not captured: at most ${max} defects get evidence per run` });
      continue;
    }
    const signal = defectSignalText(d, secrets);
    const finding = findFinding(mission, fp);
    const recording = finding?.recording ?? mission.recording;
    if (finding === undefined || recording === null) {
      byFp.set(fp, { screenshots: [], signal, skipped: "the defect has no repro Recording to replay" });
      continue;
    }
    if (mission.fixtures !== undefined) {
      byFp.set(fp, { screenshots: [], signal, skipped: "the run used mission fixtures; replay it with `verify-fix --record-video` (which restores them)" });
      continue;
    }
    if ((mission.target.actors ?? []).some((a) => a.role === "observer")) {
      byFp.set(fp, { screenshots: [], signal, skipped: "a cross-actor defect: replay it with `verify-fix --record-video`" });
      continue;
    }
    const emu = recording.emulation;
    const storageState = opts.storageState ?? mission.target.storageStatePath;
    byFp.set(
      fp,
      await replayWithEvidence({
        recording,
        stepIndex: finding.repro.recordingStepIndex,
        fingerprints: [fp, ...(finding.related ?? [])],
        signalCheckable: SIGNAL_KINDS.has(finding.kind),
        signal,
        seedUrl: mission.target.seedUrl,
        allowlist: mission.target.allowlist,
        ...(storageState === undefined ? {} : { storageState }),
        ...(emu === undefined ? {} : { emulation: emu.device !== undefined ? { device: emu.device } : { viewport: emu.viewport } }),
        outDir: join(root, fp),
        video: opts.video !== false,
        secrets,
        ...(opts.browser === undefined ? {} : { browser: opts.browser }),
        ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
        ...(opts.paceMs === undefined ? {} : { paceMs: opts.paceMs }),
        ...(opts.settleCeilingMs === undefined ? {} : { settleCeilingMs: opts.settleCeilingMs }),
      }),
    );
  }
  const withEvidence = (list: unknown): unknown =>
    Array.isArray(list) ? list.map((d) => (isRecord(d) && typeof d.fingerprint === "string" && byFp.has(d.fingerprint) ? { ...d, evidence: byFp.get(d.fingerprint) } : d)) : list;
  const updated: Record<string, unknown> = { ...r, defects: withEvidence(r.defects), ...(isRecord(r.issues) ? { issues: { ...r.issues } } : {}) };
  appendEvidenceToDrafts(updated, byFp, secrets);
  // The persisted file gets the same evidence and drafts (read back by report / check / verify-fix).
  if (isRecord(raw) && isRecord(raw.result)) {
    const file = {
      ...raw,
      result: { ...raw.result, defects: withEvidence(raw.result.defects), ...(isRecord(updated.issues) && isRecord(raw.result.issues) ? { issues: updated.issues } : {}) },
    };
    writeFileSync(opts.resultPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
  return updated as unknown as R;
}

/** The heading of a draft's media section (#250). */
export const EVIDENCE_MEDIA_HEADING = "## Repro clip and screenshots";

/** The Markdown media section of an issue draft (paths only; redacted, proven secret-free). */
export function evidenceSection(e: DefectEvidence, secrets: readonly string[]): string {
  const lines = [EVIDENCE_MEDIA_HEADING, ""];
  if (e.videoPath !== undefined) lines.push(`- Captioned repro clip: \`${e.videoPath}\`${e.signal === undefined ? "" : ` — step ${e.failingStep ?? "?"} is marked: ${e.signal}`}`);
  for (const s of e.screenshots) lines.push(`- Screenshot (${basename(s).startsWith("before") ? "just before the failing step" : "at the failing step, element highlighted"}): \`${s}\``);
  if (e.reproduced === false) lines.push("- Note: the defect did not fire on the evidence replay (it may be intermittent).");
  if (e.skipped !== undefined) lines.push(`- No media: ${e.skipped}`);
  for (const s of e.captureSkips ?? []) lines.push(`- Not captured: ${s}`);
  lines.push(
    "",
    "_GitHub's API cannot upload media, so these are links to files: commit them under the repo's `.jevitate/`, or publish them as CI artifacts and link those._",
  );
  const text = redactText(lines.join("\n"), secrets);
  assertNoSecretInPayload(text, secrets, "defect evidence section");
  return text;
}

/**
 * Inserts the media section into each defect's written draft, before its fingerprint marker. A
 * defect with media but no draft yet (a goal run drafts only crashes and hangs) gets one, when the
 * result carries `issues` — a system-under-test draft naming the defect, its signal and its media.
 */
function appendEvidenceToDrafts(result: Record<string, unknown>, byFp: ReadonlyMap<string, DefectEvidence>, secrets: readonly string[]): void {
  const issues = isRecord(result.issues) ? result.issues : undefined;
  if (issues === undefined) return;
  const drafts = Array.isArray(issues.drafts) ? issues.drafts.filter(isRecord) : [];
  const drafted = new Set(drafts.map((d) => str(d.fingerprint)).filter((f): f is string => f !== undefined));
  const recordingPath = Array.isArray(result.recordingPaths) ? str(result.recordingPaths[0]) : str(result.recordingPath);
  const defects = Array.isArray(result.defects) ? result.defects.filter(isRecord) : [];
  const fresh: IssueDraft[] = [];
  for (const d of defects) {
    const fp = str(d.fingerprint);
    const e = fp === undefined ? undefined : byFp.get(fp);
    if (fp === undefined || e === undefined || drafted.has(fp) || d.advisory === true) continue;
    if (e.videoPath === undefined && e.screenshots.length === 0) continue;
    const title = redactText(redactUrl(str(d.title) ?? `${str(d.kind) ?? "defect"} on ${str(d.route) ?? "?"}`), secrets);
    const body = [
      `jevitate observed **${title}** on \`${redactText(str(d.route) ?? "?", secrets)}\`: ${e.signal ?? str(d.kind) ?? "a defect"}.`,
      `Fingerprint \`${fp}\`${typeof d.occurrences === "number" ? ` · ${d.occurrences} occurrence(s) in this run` : ""}.`,
      ...(recordingPath === undefined ? [] : [`## Artifacts\n- Recording: \`${recordingPath}\` (replay it up to step ${e.failingStep ?? "?"} to reach the failing step)`]),
      fingerprintMarker(fp),
    ].join("\n\n");
    fresh.push({ fingerprint: fp, title: `[jevitate] ${title}`, body: redactText(body, secrets), labels: ["jevitate", "defect"], attribution: "system-under-test", targets: targetsFor("system-under-test") });
  }
  const written = recordingPath === undefined ? [] : writeIssueDrafts(recordingPath, fresh);
  const all = [...drafts, ...written.map((w) => ({ ...w }))];
  if (written.length > 0) issues.drafts = all;
  for (const d of all) {
    const fp = str(d.fingerprint);
    const path = str(d.path);
    const e = fp === undefined ? undefined : byFp.get(fp);
    if (fp === undefined || path === undefined || e === undefined || !existsSync(path)) continue;
    const md = readFileSync(path, "utf8");
    if (md.includes(`\n${EVIDENCE_MEDIA_HEADING}\n`)) continue;
    const marker = fingerprintMarker(fp);
    const section = evidenceSection(e, secrets);
    const at = md.lastIndexOf(marker);
    writeFileSync(path, at < 0 ? `${md.trimEnd()}\n\n${section}\n` : `${md.slice(0, at)}${section}\n\n${md.slice(at)}`, "utf8");
  }
}

/**
 * Files the run's drafts AFTER their evidence was attached (the run itself wrote drafts only), so
 * a filed issue links to the media. Returns the result with `issues.filing` replaced.
 */
export async function fileDraftsWithEvidence<R extends object>(result: R, config: FilingConfig, makeFiler: () => IssueFilerPort, nowIso: string): Promise<R> {
  const r = result as unknown as Record<string, unknown>;
  const issues = isRecord(r.issues) ? r.issues : undefined;
  const drafts = Array.isArray(issues?.drafts) ? issues.drafts.filter(isRecord) : [];
  if (issues === undefined || drafts.length === 0) return result;
  const filing: Array<{ fingerprint: string; outcomes: FilingOutcome[] }> = [];
  const filer = config.enabled ? makeFiler() : null;
  for (const d of drafts) {
    const fp = str(d.fingerprint);
    const path = str(d.path);
    if (fp === undefined || path === undefined || !existsSync(path)) continue;
    const md = readFileSync(path, "utf8");
    const heading = /^# (.*)\n\n/.exec(md);
    const draft: IssueDraft = {
      fingerprint: fp,
      title: str(d.title) ?? heading?.[1] ?? fp,
      body: heading === null ? md.trim() : md.slice(heading[0].length).trim(),
      labels: Array.isArray(d.labels) ? d.labels.filter((l): l is string => typeof l === "string") : [],
      attribution: d.attribution as IssueDraft["attribution"],
      targets: (Array.isArray(d.targets) ? d.targets : []) as IssueDraft["targets"],
    };
    const outcomes: FilingOutcome[] =
      filer === null ? draft.targets.map((target) => ({ target, status: "draft-only", reason: "filing is disabled" })) : await fileDraft(filer, draft, config, nowIso);
    filing.push({ fingerprint: fp, outcomes });
  }
  return { ...r, issues: { ...issues, filing } } as unknown as R;
}

/** The runner options `withRunEvidence` reads (every explore runner has them). */
export interface RunEvidenceOptions {
  readonly evidenceVideo?: boolean;
  readonly browser?: BrowserRunOptions;
  readonly browserPortFactory?: () => BrowserPort;
  readonly storageState?: string;
}

/** A runner's evidence settings: on only with `evidenceVideo`, over the run's own secrets. */
export function evidenceOf(opts: RunEvidenceOptions, secrets: readonly string[]): AttachEvidenceOptions | undefined {
  if (opts.evidenceVideo !== true) return undefined;
  return {
    resultPath: "",
    secrets,
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
  };
}

/** A written result with its defects' evidence attached (unchanged without `evidenceVideo`), then its signals triaged (`--log-triage`). */
export async function withRunEvidence<R extends { readonly resultPath: string }>(result: R, evidence: AttachEvidenceOptions | undefined, triage?: RunTriage): Promise<R> {
  const withEvidence = evidence === undefined ? result : await attachDefectEvidence(result, { ...evidence, resultPath: result.resultPath });
  // #313: then the run's signals, triaged per defect (`--log-triage`).
  return withRunTriage(withEvidence, triage);
}
