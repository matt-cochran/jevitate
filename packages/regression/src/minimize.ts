import type { Recording, PageSegment, RecordedStep } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { matchesFingerprint, type FailureFingerprint } from "./fingerprint.js";

interface FlatEntry {
  pageIndex: number;
  pageUrl: string;
  pageTitle?: string;
  step: RecordedStep;
}

function flattenWithPageInfo(rec: Recording): FlatEntry[] {
  const out: FlatEntry[] = [];
  rec.pages.forEach((page, pageIndex) => {
    page.steps.forEach((step) => out.push({ pageIndex, pageUrl: page.url, pageTitle: page.title, step }));
  });
  return out;
}

/**
 * Rebuilds a schema-valid Recording from a SUBSET of a flattened step list
 * (by object identity), regrouping consecutive same-source-page entries back
 * into `PageSegment`s. Order-preserving; drops no page explicitly (an
 * emptied page simply contributes zero steps, which never happens here
 * since `entries` only ever shrinks by whole chunks, and a wholly-dropped
 * page contributes no entries at all).
 */
function reassemble(base: Recording, entries: FlatEntry[]): Recording {
  const pages: (PageSegment & { __srcPageIndex: number })[] = [];
  for (const entry of entries) {
    const last = pages[pages.length - 1];
    if (last && last.__srcPageIndex === entry.pageIndex) {
      last.steps.push(entry.step);
    } else {
      pages.push({ url: entry.pageUrl, title: entry.pageTitle, steps: [entry.step], __srcPageIndex: entry.pageIndex });
    }
  }
  return { ...base, pages: pages.map(({ __srcPageIndex, ...p }) => p) };
}

export type Reproduces = (candidate: Recording) => Promise<boolean>;

/**
 * Builds a `Reproduces` predicate for the (already `"reproducible"`-labeled)
 * failure `fingerprint`: replays `candidate` once via a fresh actor and
 * reports true only if it fails at the SAME structural step. Single
 * attempt — flakiness is handled up front by `reproduceFailure`.
 */
export function makeSingleShotReproduces(makeActor: () => Promise<Actor>, fingerprint: FailureFingerprint): Reproduces {
  return async (candidate) => {
    const actor = await makeActor();
    const result = await new RecordingInterpreter().run(actor, candidate);
    if (result.outcome !== "failed") return false;
    return matchesFingerprint(candidate, result.at, fingerprint);
  };
}

/**
 * Zeller's ddmin over the flattened step sequence: repeatedly tries removing
 * ever-smaller contiguous chunks, keeping a removal only when the resulting
 * (schema-valid, re-flowed) Recording still satisfies `reproduces`.
 * Terminates when granularity reaches individual steps and no further
 * single-step removal reproduces.
 */
export async function minimizeRecording(recording: Recording, reproduces: Reproduces): Promise<Recording> {
  let entries = flattenWithPageInfo(recording);
  let granularity = 2;

  while (entries.length >= 2) {
    const chunkSize = Math.ceil(entries.length / granularity);
    const chunks: FlatEntry[][] = [];
    for (let i = 0; i < entries.length; i += chunkSize) chunks.push(entries.slice(i, i + chunkSize));

    let reducedThisPass = false;
    for (const chunk of chunks) {
      const complement = entries.filter((e) => !chunk.includes(e));
      if (complement.length === 0) continue;

      const candidate = reassemble(recording, complement);
      if (!RecordingSchema.safeParse(candidate).success) continue;
      if (await reproduces(candidate)) {
        entries = complement;
        granularity = Math.max(granularity - 1, 2);
        reducedThisPass = true;
        break;
      }
    }

    if (!reducedThisPass) {
      if (granularity >= entries.length) break;
      granularity = Math.min(granularity * 2, entries.length);
    }
  }

  return reassemble(recording, entries);
}
