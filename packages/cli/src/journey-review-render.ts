import type { JourneyReview } from "@jevitate/journey";
import {
  createSheetWriter,
  finishSheet,
  renderApprove,
  renderAttention,
  renderClear,
  renderFullDetail,
  renderHeader,
  renderInputs,
  renderProposal,
  renderProvesAtTheEnd,
  renderSteps,
  renderWhatItDoes,
  renderWrites,
  type Style,
} from "./journey-review/render.js";

export function evidenceLine(e: { kind: string; before?: string | undefined; after?: string | undefined; file?: string | undefined; line?: number | undefined }): string {
  const change = e.before !== undefined || e.after !== undefined ? ` '${e.before ?? ""}' → '${e.after ?? ""}'` : "";
  const where = e.file === undefined ? "" : ` (${e.file}${e.line === undefined ? "" : `:${e.line}`})`;
  return `${e.kind}${change}${where}`;
}

export function multisetDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const left = new Map<string, number>();
  for (const l of before) left.set(l, (left.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const l of before) {
    const n = left.get(l) ?? 0;
    if (n > 0) {
      removed.push(l);
      left.set(l, n - 1);
    }
  }
  return { added, removed };
}

export function validEngine(e: unknown): e is { version: string; commit: string } {
  return e !== null && typeof e === "object" && typeof (e as { version?: unknown }).version === "string" && typeof (e as { commit?: unknown }).commit === "string";
}

/** #816: the stale-proof line names what actually differs; only a changed Journey is blamed on the Journey. */
export function staleProofAttention(cause: string | undefined, id: string, recordedBy?: { readonly version: string; readonly commit: string }): { text: string; hint: string } {
  const reverify = `jevitate journey verify ${id} --mutate`;
  switch (cause) {
    case "engine":
      return {
        text: `The mutation proof was recorded by another jevitate engine${recordedBy === undefined ? "" : ` (${recordedBy.version}, ${recordedBy.commit})`}: the Journey is unchanged since it ran, but this engine computes its proof identity differently`,
        hint: `review it with the jevitate version that recorded the proof${recordedBy === undefined ? "" : ` (${recordedBy.version})`}, or re-run \`${reverify}\` with this one`,
      };
    case "engine-unknown":
      return {
        text: "The mutation proof does not match this engine, and its receipt does not say which engine recorded it (written before 0.30.0); the Journey's reviewed content is unchanged",
        hint: reverify,
      };
    case "read-policy":
      return { text: "The mutation proof is out of date: the target's safety.readRequests changed since it ran", hint: reverify };
    case "no-planner-identity":
      return { text: "The mutation proof predates proof identity (recorded before 0.14.0), so it cannot be matched to this Journey", hint: reverify };
    case "target":
      return { text: "The mutation proof ran on another target origin than the Journey's recorded site: the Journey is unchanged, but the proof is for another target", hint: reverify };
    case "app-version":
      return { text: "The mutation proof ran on another app version than JEVITATE_APP_VERSION names now: the Journey is unchanged, but the app is not", hint: reverify };
    default:
      return { text: "The mutation proof is out of date: the Journey changed after it ran", hint: reverify };
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

/** How the sheet is drawn. `width` wraps the text sheet (default 100); `color` adds ANSI; `full` adds the detail sections. */
export interface RenderOptions {
  readonly width?: number;
  readonly color?: boolean;
  readonly full?: boolean;
}

function renderSheet(r: JourneyReview, style: Style, opts: RenderOptions = {}): string {
  const w = createSheetWriter(style, opts);
  renderHeader(r, w, opts);
  renderAttention(r, w, opts);
  renderWhatItDoes(r, w, opts);
  renderInputs(r, w, opts);
  renderSteps(r, w, opts);
  renderProvesAtTheEnd(r, w, opts);
  renderWrites(r, w, opts);
  renderClear(r, w, opts);
  renderProposal(r, w, opts);
  if (opts.full === true) renderFullDetail(r, w, opts);
  renderApprove(r, w, opts);
  return finishSheet(w);
}

/** #432: the review sheet as Markdown (`journey review --markdown`). */
export function renderReviewMarkdown(review: JourneyReview, opts: RenderOptions = {}): string {
  return renderSheet(review, "markdown", opts);
}

/** #432: the review sheet as plain text (`journey review`, and `journey promote` in human mode). */
export function renderReviewText(review: JourneyReview, opts: RenderOptions = {}): string {
  return renderSheet(review, "text", opts);
}
