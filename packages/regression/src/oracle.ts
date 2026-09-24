import type { Assertion, Recording, RecordedStep, Step, TargetDescriptor } from "@jevitate/recording";

/**
 * One transcript entry from a mission — the same shape `@jevitate/explore`'s `TranscriptEntry`
 * carries, duck-typed here so this package never depends on `@jevitate/explore` (regression stays
 * a downstream consumer of Recordings/results, not of the exploration engine).
 */
export interface MissionTranscriptEntry {
  readonly op?: string | null;
  readonly actOk: boolean;
  readonly reason?: string;
  readonly url: string;
  readonly descriptor?: TargetDescriptor;
}

const ACTIONABLE_OPS = new Set(["click", "type", "select"]);

/** A failure oracle derived directly from a mission's own recorded evidence. */
export interface DerivedOracle {
  readonly step: Step;
  /** The page url the oracle step belongs on. Absent for a success-assertion oracle, which is
   * page-agnostic — the caller falls back to the recording's last page. */
  readonly url?: string;
  readonly source: "failed-action" | "success-assertion";
}

/**
 * Derives a failure oracle from a mission's transcript (#81 item 2): the LAST failed action —
 * the concrete interaction that broke (e.g. a "Pay" button that stayed disabled). Replaying it
 * against the unfixed app fails the same way (the interpreter's actionability wait times out on a
 * disabled/hidden target); against a fixed app it succeeds — exactly the pass/fail distinction a
 * regression needs. Only actionable ops (click/type/select) with a captured `descriptor` can
 * become a step; other failures (a no-target/model-decision failure, a hang) have nothing
 * page-actionable to replay and are left for `oracleFromAssertion` instead.
 */
export function deriveOracleFromTranscript(transcript: readonly MissionTranscriptEntry[]): DerivedOracle | undefined {
  const lastFailedAction = [...transcript]
    .reverse()
    .find((t) => !t.actOk && t.descriptor !== undefined && !!t.op && ACTIONABLE_OPS.has(t.op));
  if (!lastFailedAction || !lastFailedAction.descriptor) return undefined;

  const target = lastFailedAction.descriptor;
  const expect: Assertion = { kind: "visible", target };
  const step: Step =
    lastFailedAction.op === "type"
      ? { kind: "fill", target, value: { redacted: false, value: "" }, expect }
      : lastFailedAction.op === "select"
        ? { kind: "select", target, value: { redacted: false, value: "" }, expect }
        : { kind: "click", target, expect };
  return { step, url: lastFailedAction.url, source: "failed-action" };
}

/** A failure oracle built from the mission's own failed `--success` check (page/reloadThen kind — the caller has already ruled out a network check, which has no replayable `Assertion`). */
export function oracleFromAssertion(assertion: Assertion): DerivedOracle {
  return { step: { kind: "assert", check: assertion }, source: "success-assertion" };
}

/**
 * Appends a derived oracle as a trailing step of `recording` — onto the last page segment when its
 * url matches, otherwise as a new one — and returns the augmented `Recording` plus the appended
 * step's flat (page-then-step) index, ready for `fingerprintFailure`. Never mutates the input.
 */
export function appendOracleStep(recording: Recording, oracle: DerivedOracle): { augmented: Recording; flatIndex: number } {
  const lastPage = recording.pages[recording.pages.length - 1];
  const url = oracle.url ?? lastPage?.url ?? recording.site;
  const recorded: RecordedStep = { step: oracle.step };

  const pages =
    lastPage && lastPage.url === url
      ? recording.pages.map((p, i) => (i === recording.pages.length - 1 ? { ...p, steps: [...p.steps, recorded] } : p))
      : [...recording.pages, { url, steps: [recorded] }];

  const augmented: Recording = { ...recording, pages };
  const flatIndex = pages.reduce((n, p) => n + p.steps.length, 0) - 1;
  return { augmented, flatIndex };
}
