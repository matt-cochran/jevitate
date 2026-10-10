import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demoSubtitles, type DemoJourneyResult } from "./journey-demo-api.js";

/**
 * #471 — the approved demo's media record: what `catalog export --format journeeze-bundle` ships for a
 * Journey with an approved demo (journeeze-saas `docs/contract/catalog-bundle-v1.md` §4.2, §7).
 *
 * `demo approve` writes it after the Journey is promoted, ONLY when the final render ran on an
 * environment that declares `synthetic: true` (the data half of the attestation) and under
 * jz-mask-v1 (the mask half). It lives beside the Journeys at `<journeys>/.demos/<id>/`:
 * `demo.json` plus copies of the media that were PROVEN masked — each step screenshot whose capture
 * was proven, and the video (with captions-only subtitles) only when every frame and every screenshot
 * was. Anything unproven is never copied: it is listed in `leftOut` with why. A draft demo never gets
 * a record; re-approving replaces it; a demo approved elsewhere (non-synthetic) removes it.
 *
 * Every file's sha256 is recorded at render time: the export re-hashes and leaves out a file that
 * changed since (it could have been replaced by an unmasked one).
 */

export const APPROVED_DEMOS_DIR = ".demos";
export const APPROVED_DEMO_FILE = "demo.json";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHOT_RE = /^step-[0-9]{2,3}\.png$/;

export interface ApprovedDemoStep {
  /** 1-based. */
  readonly number: number;
  readonly caption: string;
  readonly expected?: string;
  /** A file name in the record's folder (`step-NN.png`), present only when that capture was proven. */
  readonly screenshot?: string;
}

export interface ApprovedDemoRecord {
  readonly kind: "jevitate.demo.approved";
  readonly version: 1;
  readonly journey: string;
  /** `journeyReviewHash` of the Journey as promoted (the approval's contentHash). */
  readonly renderedFrom: string;
  readonly approvedAtIso: string;
  /** The environment's name (declared `synthetic: true`). */
  readonly environment: string;
  readonly title?: string;
  readonly privacy: { readonly mask: "jz-mask-v1"; readonly data: "synthetic"; readonly method: "dom-before-capture"; readonly regions: number };
  readonly steps: readonly ApprovedDemoStep[];
  readonly video?: "demo.webm";
  readonly subtitles?: "demo.vtt";
  /** sha256 and size of every media file in the folder, by name. */
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>;
  /** Media left out at render time, each with why (never sent anywhere). */
  readonly leftOut: readonly string[];
}

export function approvedDemoDir(journeysDir: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`not a Journey id: ${JSON.stringify(id)}`);
  return join(journeysDir, APPROVED_DEMOS_DIR, id);
}

/** Removes `id`'s approved-demo record and media (no-op when absent). */
export async function clearApprovedDemo(journeysDir: string, id: string): Promise<void> {
  await rm(approvedDemoDir(journeysDir, id), { recursive: true, force: true });
}

async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const buf = await readFile(path);
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.byteLength };
}

export interface RecordApprovedDemoInput {
  readonly journeysDir: string;
  readonly id: string;
  readonly renderedFrom: string;
  readonly approvedAtIso: string;
  readonly environment: string;
  readonly title?: string;
  /** The final render (`demoJourney` with `jzMask`). */
  readonly demo: DemoJourneyResult;
}

/**
 * Writes `id`'s record from a jz-mask-v1 final render (replacing any older one). Throws when the
 * render carries no jz-mask-v1 proof — the caller never records an unmasked render.
 */
export async function recordApprovedDemo(input: RecordApprovedDemoInput): Promise<ApprovedDemoRecord> {
  const { demo } = input;
  if (demo.jz === undefined) throw new Error("the final demo was not rendered under jz-mask-v1 — nothing is recorded for export");
  const dir = approvedDemoDir(input.journeysDir, input.id);
  const stage = `${dir}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(stage, { recursive: true });
  try {
    const files: Record<string, { sha256: string; bytes: number }> = {};
    const leftOut: string[] = [];
    let regions = 0;
    const proof = new Map(demo.jz.steps.map((s) => [s.step, s]));
    const steps: ApprovedDemoStep[] = [];
    for (const s of demo.steps) {
      const name = `step-${String(s.number).padStart(2, "0")}.png`;
      const p = proof.get(s.number);
      let screenshot: string | undefined;
      if (p !== undefined && "leftOut" in p) leftOut.push(`step ${s.number} screenshot: ${p.leftOut}`);
      else if (p !== undefined && s.screenshot !== undefined) {
        await copyFile(s.screenshot, join(stage, name));
        files[name] = await fileDigest(join(stage, name));
        regions += p.regions;
        screenshot = name;
      }
      steps.push({ number: s.number, caption: s.caption, ...(s.expectedResult === undefined ? {} : { expected: s.expectedResult }), ...(screenshot === undefined ? {} : { screenshot }) });
    }
    let video: "demo.webm" | undefined;
    let subtitles: "demo.vtt" | undefined;
    if (!demo.jz.video.proven) leftOut.push(`video: ${demo.jz.video.reason ?? "not proven"}`);
    else if (demo.video !== undefined) {
      await copyFile(demo.video, join(stage, "demo.webm"));
      files["demo.webm"] = await fileDigest(join(stage, "demo.webm"));
      // Captions only: no goal NOTE and no observed lines — exactly the steps' captions, one cue each.
      const vtt = demoSubtitles("", demo.steps.map(({ observed: _o, ...s }) => s), false);
      await writeFile(join(stage, "demo.vtt"), vtt);
      files["demo.vtt"] = await fileDigest(join(stage, "demo.vtt"));
      video = "demo.webm";
      subtitles = "demo.vtt";
    }
    const record: ApprovedDemoRecord = {
      kind: "jevitate.demo.approved",
      version: 1,
      journey: input.id,
      renderedFrom: input.renderedFrom,
      approvedAtIso: input.approvedAtIso,
      environment: input.environment,
      ...(input.title === undefined ? {} : { title: input.title }),
      privacy: { mask: "jz-mask-v1", data: "synthetic", method: demo.jz.method, regions },
      steps,
      ...(video === undefined ? {} : { video }),
      ...(subtitles === undefined ? {} : { subtitles }),
      files,
      leftOut,
    };
    await writeFile(join(stage, APPROVED_DEMO_FILE), `${JSON.stringify(record, null, 2)}\n`);
    await rm(dir, { recursive: true, force: true });
    await rename(stage, dir);
    return record;
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
}

/** Why `v` is not an {@link ApprovedDemoRecord} for `id`, or null. */
export function approvedDemoProblem(v: unknown, id: string): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "not an object";
  const o = v as Record<string, unknown>;
  if (o.kind !== "jevitate.demo.approved" || o.version !== 1) return "not an approved-demo record (kind jevitate.demo.approved, version 1)";
  if (o.journey !== id) return `it is the record of ${JSON.stringify(o.journey)}`;
  if (typeof o.renderedFrom !== "string" || !SHA256_RE.test(o.renderedFrom)) return "renderedFrom is not a sha256";
  const p = o.privacy as Record<string, unknown> | undefined;
  if (p === undefined || p.mask !== "jz-mask-v1" || p.data !== "synthetic" || p.method !== "dom-before-capture" || !Number.isSafeInteger(p.regions) || (p.regions as number) < 0) {
    return "privacy is not a jz-mask-v1 / synthetic attestation";
  }
  if (!Array.isArray(o.steps) || o.steps.length === 0) return "steps: expected a non-empty list";
  const files = o.files as Record<string, unknown> | undefined;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return "files: expected an object";
  for (const [name, f] of Object.entries(files)) {
    if (!SHOT_RE.test(name) && name !== "demo.webm" && name !== "demo.vtt") return `files: unexpected file ${JSON.stringify(name)}`;
    const d = f as Record<string, unknown> | null;
    if (d === null || typeof d !== "object" || typeof d.sha256 !== "string" || !SHA256_RE.test(d.sha256) || !Number.isSafeInteger(d.bytes)) return `files.${name}: expected { sha256, bytes }`;
  }
  for (const [i, s] of (o.steps as unknown[]).entries()) {
    const st = s as Record<string, unknown> | null;
    if (st === null || typeof st !== "object" || st.number !== i + 1 || typeof st.caption !== "string") return `steps[${i}]: expected { number: ${i + 1}, caption }`;
    if (st.expected !== undefined && typeof st.expected !== "string") return `steps[${i}].expected: expected text`;
    if (st.screenshot !== undefined && (typeof st.screenshot !== "string" || !SHOT_RE.test(st.screenshot) || !(st.screenshot in files))) return `steps[${i}].screenshot: not a listed step-NN.png`;
  }
  if (o.video !== undefined && (o.video !== "demo.webm" || !("demo.webm" in files))) return "video: not a listed demo.webm";
  if (o.subtitles !== undefined && (o.subtitles !== "demo.vtt" || !("demo.vtt" in files))) return "subtitles: not a listed demo.vtt";
  if (o.title !== undefined && typeof o.title !== "string") return "title: expected text";
  return null;
}

/**
 * Reads `id`'s record: null when there is none (no approved demo on a synthetic environment).
 * Throws on an unreadable or invalid record (the export leaves the demo out with that reason).
 */
export async function readApprovedDemo(journeysDir: string, id: string): Promise<{ record: ApprovedDemoRecord; dir: string } | null> {
  const dir = approvedDemoDir(journeysDir, id);
  let raw: string;
  try {
    raw = await readFile(join(dir, APPROVED_DEMO_FILE), "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  const problem = approvedDemoProblem(parsed, id);
  if (problem !== null) throw new Error(`${join(dir, APPROVED_DEMO_FILE)}: ${problem}`);
  return { record: parsed as ApprovedDemoRecord, dir };
}

/** The file's current sha256 and size, or null when it is missing or not a plain file (a symlink is not). */
export async function currentDigest(path: string): Promise<{ sha256: string; bytes: number } | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    return await fileDigest(path);
  } catch {
    return null;
  }
}
