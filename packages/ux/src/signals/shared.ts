import type { SignalEvidence, SignalRequest, SignalStep } from "./types.js";

/**
 * Helpers shared by more than one signal-detector family (`basic.ts`, `journey.ts`) — none of these
 * were exported from the pre-split `signals.ts` either, so this module is never re-exported by the
 * `signals.ts` barrel.
 */

export const API_TYPES = new Set(["fetch", "xhr"]);
/** On-screen words that tell the user work is in progress. */
export const BUSY_TEXT = /\b(loading|processing|running|in progress|please wait|pending|queued|working on|simulating|generating|saving|submitting|uploading)\b|…|\.\.\.|\b\d{1,3}\s?%/i;

export function durationOf(r: SignalRequest, endedAt: number): number {
  return Math.max(0, (r.endedAt ?? endedAt) - r.startedAt);
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function requestEvidence(r: SignalRequest, endedAt: number): SignalEvidence["requests"][number] {
  return { id: r.id, method: r.method, url: r.url, status: r.status, durationMs: durationOf(r, endedAt), pending: r.endedAt === null, step: r.step };
}

export function secs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`;
}

export function okStatus(r: SignalRequest): boolean {
  return r.failed !== true && r.status !== null && r.status >= 200 && r.status < 400;
}

export function controlKey(s: SignalStep): string {
  return s.descriptor === undefined ? `target:${s.target ?? ""}` : JSON.stringify(s.descriptor);
}

/** Positive step numbers, deduped and ordered (a screen's step is always ≥ 1). */
export function uniqueSteps(steps: readonly number[]): number[] {
  return [...new Set(steps.filter((s) => s > 0))].sort((a, b) => a - b);
}

export function quoteLine(text: string, needle: string): string {
  const line = text.split(/\n/).find((l) => l.includes(needle)) ?? needle;
  const t = line.replace(/\s+/g, " ").trim();
  return t.length <= 160 ? t : `${t.slice(0, 157)}...`;
}
