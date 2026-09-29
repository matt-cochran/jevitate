import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import type { Page } from "playwright";
import { assertNoSecretInPayload, redactText, redactUrl } from "@jevitate/ai-core";
import { coverageStateFingerprint, snapshot, type TranscriptEntry } from "@jevitate/explore";
import type { StepObserver } from "@jevitate/interpreter";
import { captureStepScreenshot, SecretPixelMask } from "./demo-capture.js";

/**
 * #251 — `--screenshots [dir]` / `--screenshots steps`: a screenshot capture mode for any run
 * (explore strategies, `journey run`/`annotate`/`demo`, `verify-fix`).
 *
 *  - `screens` (the default): one screenshot per DISTINCT screen — deduplicated by the page-state
 *    fingerprint coverage already uses (`coverageStateFingerprint`: the url template plus the
 *    control table), so a new screen is a new state;
 *  - `steps`: one per step.
 *
 * Every image is the viewport after the step acted, with the demo overlay hidden and every
 * registered secret masked in pixels ({@link SecretPixelMask}); a capture whose mask cannot be
 * proven is SKIPPED and its reason recorded (fail closed). An `index.md` contact sheet lists each
 * image with its step, route and what happened (all text redacted, proven secret-free before it is
 * written). The paths go in the result as `screenshotPaths` (+ `screenshotIndex`, and
 * `screenshotsSkipped` when a capture was refused).
 */

export type ScreenshotMode = "screens" | "steps";

export interface ScreenshotsSpec {
  readonly mode: ScreenshotMode;
  /** Where the images go; absent ⇒ `<run artifact stem>.screenshots/` beside the run's output. */
  readonly dir?: string;
}

/** An unusable `--screenshots` value: refused before anything runs (exit 64). */
export class ScreenshotsArgError extends Error {
  readonly code = "E_SCREENSHOTS_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotsArgError";
  }
}

/**
 * `--screenshots` → the spec: bare / `screens` → one per distinct screen; `steps` → one per step;
 * `screens:<dir>` / `steps:<dir>` → that mode into `<dir>`; any other value is the directory
 * (screens mode). An empty value is refused.
 */
export function parseScreenshotsArg(v: string | boolean | undefined, where = "--screenshots"): ScreenshotsSpec | undefined {
  if (v === undefined || v === false) return undefined;
  if (v === true) return { mode: "screens" };
  const t = v.trim();
  if (t === "") throw new ScreenshotsArgError(`${where} needs a mode or a directory: screens, steps, screens:<dir>, steps:<dir> or <dir>`);
  if (t === "screens" || t === "steps") return { mode: t };
  const m = /^(screens|steps):(.*)$/.exec(t);
  if (m !== null) {
    const dir = (m[2] ?? "").trim();
    if (dir === "") throw new ScreenshotsArgError(`${where} ${m[1]}: needs a directory after the colon`);
    return { mode: m[1] as ScreenshotMode, dir: resolvePath(dir) };
  }
  return { mode: "screens", dir: resolvePath(t) };
}

/** The run's screenshot folder: `spec.dir`, else `<dir of artifact>/<artifact stem>.screenshots`. */
export function screenshotsDirFor(spec: ScreenshotsSpec, artifactPath: string): string {
  if (spec.dir !== undefined) return spec.dir;
  const stem = basename(artifactPath).replace(/\.result\.json$/, "").replace(/\.json$/, "");
  return join(dirname(artifactPath), `${stem}.screenshots`);
}

export interface ScreenshotEntry {
  /** 1-based image number. */
  readonly n: number;
  /** The step it shows (after that step acted). */
  readonly step: number;
  /** The route (path) it was taken on, redacted. */
  readonly route: string;
  /** What the step did (redacted). */
  readonly what: string;
  readonly path: string;
}

export interface ScreenshotSkip {
  readonly step: number;
  readonly reason: string;
}

/** The additive result fields (schemaVersion 1). */
export interface ScreenshotsResult {
  readonly screenshotPaths: string[];
  readonly screenshotIndex: string;
  readonly screenshotsSkipped?: ScreenshotSkip[];
}

export interface RunScreenshotsOptions {
  readonly spec: ScreenshotsSpec;
  /** The resolved folder (see {@link screenshotsDirFor}). */
  readonly dir: string;
  /** Every registered secret: masked in pixels, redacted in the index. */
  readonly secrets: readonly string[];
  /** The contact sheet's heading (redacted). */
  readonly title: string;
  /** A shared mask (e.g. the one a masking port installed); default: a new one over `secrets`. */
  readonly mask?: SecretPixelMask;
}

const FINGERPRINT_MS = 10_000;

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function routeOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search === "" ? "" : u.search);
  } catch {
    return url;
  }
}

/** A transcript step as one "what happened" line. */
export function describeTranscriptEntry(e: TranscriptEntry): string {
  const act = e.op === null ? "no action" : `${e.op}${e.target === null ? "" : ` ${e.target}`}`;
  return e.actOk ? act : `${act} — failed${e.reason === undefined ? "" : `: ${e.reason}`}`;
}

export class RunScreenshots {
  readonly mask: SecretPixelMask;
  readonly #opts: RunScreenshotsOptions;
  readonly #entries: ScreenshotEntry[] = [];
  readonly #skipped: ScreenshotSkip[] = [];
  readonly #seen = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #prepared: Promise<void> | undefined;
  #maxStep = 0;

  constructor(opts: RunScreenshotsOptions) {
    this.#opts = opts;
    this.mask = opts.mask ?? new SecretPixelMask(opts.secrets);
  }

  get mode(): ScreenshotMode {
    return this.#opts.spec.mode;
  }

  #redact(s: string): string {
    return redactText(s, this.#opts.secrets);
  }

  /** Creates the folder once and clears a previous run's images (never another file). */
  #prepare(): Promise<void> {
    this.#prepared ??= (async () => {
      await mkdir(this.#opts.dir, { recursive: true });
      for (const f of await readdir(this.#opts.dir)) if (/^\d+-step-\d+\.png$/.test(f)) await rm(join(this.#opts.dir, f), { force: true });
    })();
    return this.#prepared;
  }

  /** Captures the page after `step` (queued: captures never overlap). Never throws. */
  capture(page: Page, at: { readonly step: number; readonly url?: string; readonly what: string }): Promise<void> {
    const run = async (): Promise<void> => {
      this.#maxStep = Math.max(this.#maxStep, at.step);
      try {
        if (page.isClosed()) throw new Error("the page is closed");
        await this.#prepare();
        if (this.#opts.spec.mode === "screens") {
          const fp = await Promise.race([
            snapshot(page).then((s) => coverageStateFingerprint(s)),
            new Promise<null>((r) => setTimeout(() => r(null), FINGERPRINT_MS)),
          ]).catch(() => null);
          // An unreadable state cannot be proven a repeat: it is captured (never silently dropped).
          if (fp !== null && this.#seen.has(fp)) return;
          await this.#shoot(page, at);
          if (fp !== null && this.#entries.some((e) => e.step === at.step)) this.#seen.add(fp);
          return;
        }
        await this.#shoot(page, at);
      } catch (err) {
        this.#skipped.push({ step: at.step, reason: this.#redact(oneLine(err instanceof Error ? err.message : String(err))).slice(0, 300) });
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next;
    return next;
  }

  async #shoot(page: Page, at: { readonly step: number; readonly url?: string; readonly what: string }): Promise<void> {
    const n = this.#entries.length + 1;
    const path = join(this.#opts.dir, `${String(n).padStart(2, "0")}-step-${String(at.step).padStart(2, "0")}.png`);
    await captureStepScreenshot(page, path, { step: at.step }, [this.mask.layer()]);
    const url = at.url ?? page.url();
    this.#entries.push({
      n,
      step: at.step,
      route: this.#redact(redactUrl(routeOf(url))),
      what: this.#redact(oneLine(at.what)).slice(0, 300),
      path,
    });
  }

  /** TranscriptLog listener hook (explore runners): captures the page after the step just recorded. */
  noteEntry(page: Page, entry: TranscriptEntry): void {
    void this.capture(page, { step: entry.step, what: describeTranscriptEntry(entry) });
  }

  /** Every capture done; writes `index.md`; the result fields. */
  async finish(): Promise<ScreenshotsResult> {
    await this.#queue;
    await this.#prepare();
    const index = join(this.#opts.dir, "index.md");
    const md = this.contactSheet();
    assertNoSecretInPayload(md, this.#opts.secrets, "screenshot index"); // the last line: never at rest
    await writeFile(index, md, "utf8");
    return {
      screenshotPaths: this.#entries.map((e) => e.path),
      screenshotIndex: index,
      ...(this.#skipped.length === 0 ? {} : { screenshotsSkipped: [...this.#skipped] }),
    };
  }

  /** The Markdown contact sheet (images linked relative to the index). */
  contactSheet(): string {
    const mode = this.#opts.spec.mode === "screens" ? "one per distinct screen" : "one per step";
    const lines = [
      `# Screenshots: ${oneLine(this.#redact(this.#opts.title))}`,
      "",
      `Mode: ${mode} · ${this.#entries.length} screenshot(s) over ${this.#maxStep} step(s). The demo overlay is hidden and registered secrets are masked in every image.`,
      "",
    ];
    for (const e of this.#entries) {
      const file = basename(e.path);
      lines.push(`## ${e.n}. Step ${e.step} · \`${e.route.replace(/`/g, "'")}\``, "", `**What happened:** ${e.what}`, "", `![Step ${e.step}: ${e.route.replace(/[[\]]/g, "")}](${encodeURI(file)})`, "");
    }
    if (this.#skipped.length > 0) {
      lines.push("## Not captured", "", ...this.#skipped.map((s) => `- step ${s.step}: ${s.reason}`), "");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }
}

/** A per-step observer for an interpreter-driven replay (journey run/annotate/demo, verify-fix). */
export function screenshotObserver(shots: RunScreenshots, pageOf: (actor: Parameters<NonNullable<StepObserver["afterStep"]>>[0]["actor"]) => Page, whatOf: (index: number) => string): StepObserver {
  return {
    afterStep: async ({ actor, index, outcome }) => {
      const what = `${whatOf(index)}${outcome === "done" ? "" : outcome === "failed" ? " — failed" : " — waiting for a human"}`;
      await shots.capture(pageOf(actor), { step: index + 1, what });
    },
  };
}

/** Runs every observer's hooks in order (an observer never changes the replay). */
export function composeObservers(...observers: ReadonlyArray<StepObserver | undefined>): StepObserver {
  const list = observers.filter((o): o is StepObserver => o !== undefined);
  const each = async (fn: (o: StepObserver) => Promise<void> | undefined): Promise<void> => {
    for (const o of list) {
      try {
        await fn(o);
      } catch {
        // One observer's failure never skips the next (nor changes the replay).
      }
    }
  };
  return {
    beforeStep: (ctx) => each((o) => o.beforeStep?.(ctx)),
    afterStep: (ctx) => each((o) => o.afterStep?.(ctx)),
  };
}

/** The human summary line for a run's screenshots (#251). */
export function formatScreenshotsLine(r: { readonly screenshotPaths?: readonly string[]; readonly screenshotIndex?: string; readonly screenshotsSkipped?: readonly ScreenshotSkip[] }): string {
  if (r.screenshotIndex === undefined) return "";
  const skipped = r.screenshotsSkipped ?? [];
  return (
    `screenshots: ${(r.screenshotPaths ?? []).length} — index ${r.screenshotIndex}` +
    `${skipped.length === 0 ? "" : ` (${skipped.length} not captured: ${skipped.map((s) => `step ${s.step}: ${s.reason}`).join("; ")})`}\n`
  );
}
