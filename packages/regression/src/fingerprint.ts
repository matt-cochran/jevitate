import type { Recording, RecordedStep } from "@jevitate/recording";
import { strictSignature } from "@jevitate/recording";

export interface FailureFingerprint {
  readonly stepSignature: string;
}

/**
 * Flattens a Recording's pages into (RecordedStep, pageUrl) pairs, in the
 * same page-then-step order `@jevitate/interpreter`'s internal flatten()
 * uses — `RecordingInterpreter.run`'s `at` indexes into this same order.
 */
export function flattenWithUrls(rec: Recording): { step: RecordedStep; pageUrl: string }[] {
  const out: { step: RecordedStep; pageUrl: string }[] = [];
  for (const page of rec.pages) {
    for (const step of page.steps) out.push({ step, pageUrl: page.url });
  }
  return out;
}

export function fingerprintFailure(rec: Recording, atFlatIndex: number): FailureFingerprint {
  const flat = flattenWithUrls(rec);
  const entry = flat[atFlatIndex];
  if (!entry) {
    throw new Error(`fingerprintFailure: index ${atFlatIndex} out of range for a ${flat.length}-step recording`);
  }
  return { stepSignature: strictSignature(entry.step.step, entry.pageUrl) };
}

export function matchesFingerprint(rec: Recording, atFlatIndex: number, fp: FailureFingerprint): boolean {
  const flat = flattenWithUrls(rec);
  const entry = flat[atFlatIndex];
  if (!entry) return false;
  return strictSignature(entry.step.step, entry.pageUrl) === fp.stepSignature;
}
