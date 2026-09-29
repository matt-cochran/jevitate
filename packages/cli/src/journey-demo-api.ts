import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  FsJourneyStore,
  applyAnnotationDraft,
  describeStep,
  flatJourneySteps,
  secretParamValues,
  type AnnotationDraft,
  type FlatJourneyStep,
  type Journey,
} from "@jevitate/journey";
import { assertNoSecretInPayload, redactText } from "@jevitate/ai-core";
import { DemoOverlay } from "@jevitate/explore";
import { RecordingInterpreter, type StepObserver } from "@jevitate/interpreter";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import type { TargetDescriptor } from "@jevitate/recording";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { captureStepScreenshot, type CaptureLayer } from "./demo-capture.js";
import { runJourneyProgrammatically, UnknownJourneyError, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";

/**
 * #248 — `jevitate journey demo <id>`: replay a Journey as a narrated demo. The overlay (#245) shows
 * the Journey's goal as a title card, each step's objective as the caption (else its label, else a
 * value-free description) with its target highlighted and a `pace` pause, then an outcome card. The
 * outputs are made from the SAME replay: a video (Playwright recordVideo, WebM) with WebVTT subtitles
 * timed to the captions, and a Markdown guide (goal, preconditions, per step its objective, expected
 * result and a screenshot with the overlay hidden).
 *
 * The replay is `runJourneyProgrammatically` — the same fail-closed policy (paid/destructive steps
 * refused), site policy, fixtures and environment (#247) as `journey run`; a demo never heals. A
 * Journey that no longer replays is STALE: nothing is written and the command exits non-zero, so a
 * CI job regenerating demos catches it. Every caption, cue and guide line is redacted with the run's
 * secret parameters, and the written text is proven secret-free before it lands (pixels in the
 * screenshots are a capture layer's job — see `demo-capture.ts`).
 */

/** How long each caption is shown before its step acts (`--pace`, ms). */
export const DEMO_DEFAULT_PACE_MS = 1500;
/** `--pace` bounds (ms). */
export const DEMO_MAX_PACE_MS = 60_000;

/** A demo's inputs were unusable (an output path of the wrong kind): nothing ran. */
export class DemoArgsError extends Error {
  readonly code = "E_JOURNEY_DEMO_ARGS";
}
/** The replay completed but a promised output could not be produced (no video file, a missing screenshot). */
export class DemoOutputError extends Error {
  readonly code = "E_JOURNEY_DEMO_OUTPUT";
}

export interface DemoJourneyOptions extends Omit<RunJourneyProgrammaticallyOptions, "interpreter" | "policy" | "selfHealer"> {
  /** The video to write (`.webm`); its subtitles go beside it as `.vtt`. Absent: no video. */
  video?: string;
  /** The Markdown guide to write (`.md`); screenshots go in `<name>.assets/` beside it. Absent: no guide. */
  guide?: string;
  /** Caption time per step before it acts (ms). Default {@link DEMO_DEFAULT_PACE_MS}. */
  paceMs?: number;
  /** Extra screenshot layers (e.g. pixel masking, #250/#251); the overlay is always hidden. */
  captureLayers?: readonly CaptureLayer[];
  /**
   * #249: a reviewed-but-unapproved annotation draft (#246) whose goal / criteria / objectives /
   * expected results narrate this demo. Applied in memory only — the stored Journey is untouched.
   */
  annotations?: AnnotationDraft;
  /** #249: an unapproved demo — a `DRAFT` watermark on the overlay, and every output marked DRAFT. */
  draft?: boolean;
}

/** #249: the mark every output of an unapproved demo carries. */
export const DEMO_DRAFT_MARK = "DRAFT";

export interface DemoStep {
  /** 1-based. */
  readonly number: number;
  /** What the overlay and the subtitle said (redacted). */
  readonly caption: string;
  readonly expectedResult?: string;
  /** The subtitle cue, ms from the start of the video. */
  readonly cue: { readonly startMs: number; readonly endMs: number };
  /** The step's screenshot in the guide's assets folder (a guide was asked for). */
  readonly screenshot?: string;
}

export interface DemoJourneyResult {
  readonly id: string;
  /** `stale`: the Journey no longer replays — nothing was written. */
  readonly outcome: "ok" | "stale";
  /** Why a stale demo stopped (redacted). */
  readonly reason?: string;
  /** The 1-based step a stale demo stopped at, when known. */
  readonly stoppedAtStep?: number;
  readonly totalSteps: number;
  /** The steps the replay reached, in order. */
  readonly steps: DemoStep[];
  readonly video?: string;
  readonly subtitles?: string;
  readonly guide?: string;
}

/** A WebVTT timestamp: `HH:MM:SS.mmm`. */
export function vttTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)}.${pad(t % 1000, 3)}`;
}

/** Cue text on one line with WebVTT's markup characters escaped (and never a `-->`). */
function vttText(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The WebVTT subtitles: one cue per step (`step-N`), in order; the goal as a leading NOTE. A draft
 * (#249) says so in a NOTE and at the start of every cue.
 */
export function demoSubtitles(title: string, steps: readonly DemoStep[], draft = false): string {
  const note = title.replace(/\s+/g, " ").replace(/-->/g, "->").trim();
  const mark = draft ? `[${DEMO_DRAFT_MARK}] ` : "";
  const cues = steps.map((s) => `step-${s.number}\n${vttTime(s.cue.startMs)} --> ${vttTime(s.cue.endMs)}\n${vttText(`${mark}${s.caption}`)}\n`);
  const draftNote = draft ? [`NOTE ${DEMO_DRAFT_MARK}: not yet approved (jevitate demo approve)\n`] : [];
  return ["WEBVTT\n", ...draftNote, ...(note === "" ? [] : [`NOTE ${note}\n`]), ...cues].join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The Markdown guide (all text already redacted); `assets` is the screenshots folder's name. A draft
 * (#249) carries `DRAFT` in its title and a watermark line under it.
 */
export function demoGuide(journey: Journey, title: string, steps: readonly DemoStep[], assets: string, redact: (s: string) => string, draft = false): string {
  const m = journey.metadata;
  const lines: string[] = [`# ${draft ? `${DEMO_DRAFT_MARK}: ` : ""}${oneLine(redact(m.name))}`, ""];
  if (draft) lines.push(`> **${DEMO_DRAFT_MARK}** — not yet approved. Review it, then run \`jevitate demo approve ${m.id}\` to promote the Journey and render the final demo.`, "");
  lines.push(`**Goal:** ${oneLine(title)}`, "");
  if (m.persona !== undefined || m.role !== undefined) {
    const who = [m.persona, m.role === undefined ? undefined : `role: ${m.role}`].filter((x): x is string => x !== undefined);
    lines.push(`**Who:** ${oneLine(redact(who.join(" · ")))}`, "");
  }
  lines.push("## Before you start", "");
  const pre = (m.preconditions ?? []).map((p) => `- ${oneLine(redact(p.description))}${p.login === true ? " (signed in)" : ""}`);
  if (m.requiresAuth === true && !(m.preconditions ?? []).some((p) => p.login === true)) pre.push("- You are signed in.");
  lines.push(...(pre.length === 0 ? ["Nothing to set up."] : pre), "", "## Steps", "");
  for (const s of steps) {
    lines.push(`### ${s.number}. ${oneLine(s.caption)}`, "");
    if (s.expectedResult !== undefined) lines.push(`**Expected result:** ${oneLine(s.expectedResult)}`, "");
    if (s.screenshot !== undefined) {
      const alt = `Step ${s.number}: ${oneLine(s.caption)}`.replace(/[[\]]/g, "");
      lines.push(`![${alt}](${encodeURI(`${assets}/${basename(s.screenshot)}`)})`, "");
    }
  }
  const criteria = (m.successCriteria ?? []).map((c) => `- ${oneLine(redact(c.description))}`);
  if (criteria.length > 0) lines.push("## When it worked", "", ...criteria, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The step's caption: its objective, else its label, else a value-free description (redacted). */
function captionOf(s: FlatJourneyStep, redact: (t: string) => string): string {
  const pick = [s.recorded.objective, s.recorded.step.label].map((t) => (t ?? "").trim()).find((t) => t !== "");
  return oneLine(redact(pick ?? describeStep(s.recorded.step)));
}

function targetOf(s: FlatJourneyStep): TargetDescriptor | null {
  const step = s.recorded.step as { target?: TargetDescriptor };
  return step.target ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `<dir>/<name>.assets` for `<dir>/<name>.md`. */
export function guideAssetsDir(guide: string): string {
  return join(dirname(guide), `${basename(guide).replace(/\.md$/i, "")}.assets`);
}

/** `<video without .webm>.vtt`. */
export function subtitlesPathFor(video: string): string {
  return video.replace(/\.webm$/i, ".vtt");
}

/**
 * Replays the Journey as a narrated demo and writes the asked-for outputs (see the module comment).
 * Throws `UnknownJourneyError` / `DemoArgsError` before any browser opens, and every refusal
 * `runJourneyProgrammatically` has; returns `outcome: "stale"` (writing nothing) when the replay stops.
 */
export async function demoJourney(opts: DemoJourneyOptions): Promise<DemoJourneyResult> {
  if (opts.video !== undefined && !/\.webm$/i.test(opts.video)) {
    throw new DemoArgsError(`--video must be a .webm file (Playwright records WebM; convert it afterwards, e.g. with ffmpeg): ${opts.video}`);
  }
  if (opts.guide !== undefined && !/\.md$/i.test(opts.guide)) throw new DemoArgsError(`--guide must be a Markdown (.md) file: ${opts.guide}`);
  const pace = opts.paceMs ?? DEMO_DEFAULT_PACE_MS;
  if (!Number.isSafeInteger(pace) || pace < 0 || pace > DEMO_MAX_PACE_MS) throw new DemoArgsError(`--pace must be an integer from 0 to ${DEMO_MAX_PACE_MS} (got ${pace})`);

  const stored = await new FsJourneyStore(opts.dir).get(opts.id);
  if (stored === null) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  // #249: a draft's annotations narrate the demo without being written into the Journey.
  const journey = opts.annotations === undefined ? stored : applyAnnotationDraft(stored, opts.annotations).journey;
  const draft = opts.draft === true;
  const secrets = secretParamValues(journey, opts.params);
  const redact = (s: string): string => redactText(s, secrets);
  const flat = flatJourneySteps(journey);
  const title = oneLine(redact((journey.metadata.goal ?? "").trim() || journey.metadata.name));

  const work = await mkdtemp(join(tmpdir(), "jevitate-demo-"));
  try {
    const overlay = new DemoOverlay(secrets);
    // The video starts with the session's page (the last thing `open` makes): cues count from there.
    let videoStart: number | undefined;
    const basePort = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
    const timedPort = (): BrowserPort => {
      const port = basePort();
      return {
        open: async (o) => {
          const session = await port.open(o);
          videoStart = performance.now();
          return session;
        },
      };
    };
    const since = (): number => performance.now() - (videoStart ?? performance.now());

    const steps: Array<{ number: number; caption: string; expectedResult?: string; startMs: number; endMs?: number; screenshot?: string }> = [];
    const captureErrors: string[] = [];
    const shots = join(work, "shots");
    await mkdir(shots, { recursive: true });
    const closeLast = (): void => {
      const last = steps[steps.length - 1];
      if (last !== undefined && last.endMs === undefined) last.endMs = Math.max(since(), last.startMs + 1);
    };

    const observer: StepObserver = {
      beforeStep: async ({ actor, index }) => {
        const page = actor.ability(BrowseTheWebToken).session.page;
        const s = flat[index];
        if (s === undefined) return;
        if (index === 0) {
          if (draft) await overlay.watermark(page, DEMO_DRAFT_MARK);
          await overlay.card(page, title, "title");
          await sleep(pace);
        }
        closeLast();
        const caption = captionOf(s, redact);
        const expected = oneLine(redact(s.recorded.expectedResult ?? ""));
        steps.push({ number: index + 1, caption, ...(expected === "" ? {} : { expectedResult: expected }), startMs: since() });
        await overlay.caption(page, { head: `step ${index + 1} of ${flat.length}`, text: caption }, targetOf(s));
        await sleep(pace);
      },
      afterStep: async ({ actor, index, outcome }) => {
        const page = actor.ability(BrowseTheWebToken).session.page;
        if (outcome === "done") {
          // A navigation re-renders the overlay asynchronously: re-apply it so the video shows it now.
          await overlay.refresh(page);
          if (opts.guide !== undefined) {
            const file = join(shots, `step-${String(index + 1).padStart(2, "0")}.png`);
            try {
              await captureStepScreenshot(page, file, { step: index + 1 }, opts.captureLayers ?? []);
              const entry = steps.find((x) => x.number === index + 1);
              if (entry !== undefined) entry.screenshot = file;
            } catch (err) {
              captureErrors.push(`step ${index + 1}: ${redact(err instanceof Error ? err.message : String(err))}`);
            }
          }
          if (index === flat.length - 1) {
            closeLast();
            await overlay.card(page, `Done: ${title}`, "ok");
            await sleep(pace);
          }
        } else {
          closeLast();
          await overlay.card(page, `Stopped at step ${index + 1}: this demo no longer replays`, "bad");
          await sleep(pace);
        }
      },
    };

    const { video, guide, paceMs: _pace, captureLayers: _layers, annotations: _annotations, draft: _draft, ...runOpts } = opts;
    const browser = video === undefined ? opts.browser : { ...opts.browser, recordVideo: { dir: work } };
    const run = await runJourneyProgrammatically({
      ...runOpts,
      ...(browser === undefined ? {} : { browser }),
      browserPortFactory: timedPort,
      interpreter: new RecordingInterpreter({ observer }),
    });
    closeLast();
    const done: DemoStep[] = steps.map((s) => ({
      number: s.number,
      caption: s.caption,
      ...(s.expectedResult === undefined ? {} : { expectedResult: s.expectedResult }),
      cue: { startMs: Math.round(s.startMs), endMs: Math.round(s.endMs ?? s.startMs + 1) },
      ...(s.screenshot === undefined ? {} : { screenshot: s.screenshot }),
    }));

    if (run.outcome === "quarantined") {
      const at = run.at === undefined ? undefined : run.at + 1;
      return {
        id: opts.id,
        outcome: "stale",
        reason: redact(run.reason).slice(0, 2000),
        ...(at === undefined ? {} : { stoppedAtStep: at }),
        totalSteps: flat.length,
        steps: done.map(({ screenshot: _s, ...s }) => s),
      };
    }

    // The replay completed: every promised output must exist — never a silently partial demo.
    if (guide !== undefined) {
      const missing = done.filter((s) => s.screenshot === undefined).map((s) => s.number);
      if (captureErrors.length > 0 || missing.length > 0) {
        throw new DemoOutputError(`could not capture a screenshot for step(s) ${missing.join(", ")}${captureErrors.length > 0 ? `: ${captureErrors.join("; ")}` : ""}`);
      }
    }
    let videoFile: string | undefined;
    if (video !== undefined) {
      videoFile = run.videoPaths?.[0];
      if (videoFile === undefined) throw new DemoOutputError("the replay recorded no video");
    }

    const result: { video?: string; subtitles?: string; guide?: string; steps: DemoStep[] } = { steps: done };
    if (video !== undefined && videoFile !== undefined) {
      const vtt = demoSubtitles(title, done, draft);
      assertNoSecretInPayload(vtt, secrets, "demo subtitles"); // the last line: never at rest
      await mkdir(dirname(video), { recursive: true });
      await copyFile(videoFile, video);
      const subtitles = subtitlesPathFor(video);
      await writeFile(subtitles, vtt);
      Object.assign(result, { video, subtitles });
    }
    if (guide !== undefined) {
      const assets = guideAssetsDir(guide);
      await mkdir(assets, { recursive: true });
      // A regenerated guide never keeps an older, longer run's screenshots.
      for (const f of await readdir(assets)) if (/^step-\d+\.png$/.test(f)) await rm(join(assets, f), { force: true });
      const placed = await Promise.all(
        done.map(async (s) => {
          if (s.screenshot === undefined) return s;
          const to = join(assets, basename(s.screenshot));
          await copyFile(s.screenshot, to);
          return { ...s, screenshot: to };
        }),
      );
      const md = demoGuide(journey, title, placed, basename(assets), redact, draft);
      assertNoSecretInPayload(md, secrets, "demo guide");
      await writeFile(guide, md);
      Object.assign(result, { guide, steps: placed });
    }
    return { id: opts.id, outcome: "ok", totalSteps: flat.length, ...result };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
