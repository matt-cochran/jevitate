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
  /**
   * Set by `@jevitate/explore`'s transcript builder when a step was refused by JEVITATE'S OWN
   * guard/fail-closed logic (the repeated-side-effect guard #92, a budget/fail-closed refusal, …)
   * BEFORE any interaction with the app was attempted — never when the app itself was interacted
   * with and reported the failure. See `TranscriptEntry.origin` in `@jevitate/explore`.
   */
  readonly origin?: "engine";
}

const ACTIONABLE_OPS = new Set(["click", "type", "select"]);

/**
 * A defense-in-depth text match for an engine-authored refusal on a transcript that predates the
 * `origin` marker (#119/#129): the mission's own repeated-side-effect guard, a budget/fail-closed
 * cutoff, or a value/message-generation refusal — none of these are the app failing, so none may
 * become "the" oracle a regression replays. `origin: "engine"` (checked first, in
 * `deriveOracleFromTranscript`) is authoritative when present; this is only a fallback.
 */
const ENGINE_REFUSAL_TEXT =
  /^(repeated side effect refused|reload deferred|action budget exhausted|no valid target \(fail-closed\)|no (?:message|value) available \(fail-closed\)|(?:value|message) generation unavailable|typed value rejected|no valid option chosen[^]*\(fail-closed\)|send without a message \(fail-closed\)|repeated type into|message not sent: it repeats)/;

/** True when `entry` is a step jevitate's own engine refused — never a valid oracle source. */
function isEngineRefusal(entry: MissionTranscriptEntry): boolean {
  if (entry.origin === "engine") return true;
  return ENGINE_REFUSAL_TEXT.test((entry.reason ?? "").trim());
}

/** A failure oracle derived directly from a mission's own recorded evidence. */
export interface DerivedOracle {
  readonly step: Step;
  /** The page url the oracle step belongs on. Absent for a success-assertion oracle, which is
   * page-agnostic — the caller falls back to the recording's last page. */
  readonly url?: string;
  readonly source: "failed-action" | "success-assertion";
}

/**
 * Derives a failure oracle from a mission's transcript (#81 item 2): the LAST APP-CAUSED failed
 * action — the concrete interaction that broke (e.g. a "Pay" button that stayed disabled).
 * Replaying it against the unfixed app fails the same way (the interpreter's actionability wait
 * times out on a disabled/hidden target); against a fixed app it succeeds — exactly the pass/fail
 * distinction a regression needs. Only actionable ops (click/type/select) with a captured
 * `descriptor` can become a step; other failures (a no-target/model-decision failure, a hang) have
 * nothing page-actionable to replay and are left for `oracleFromAssertion` instead.
 *
 * NEVER jevitate's own engine (#119/#129): a step jevitate refused itself — the repeated-side-effect
 * guard (#92), a budget/fail-closed cutoff, a value/message-generation failure — is excluded
 * (`isEngineRefusal`) even though it is `actOk: false` with a descriptor, because replaying it can
 * never fail against a fixed app (nothing about the app changed; jevitate would refuse it again the
 * same way regardless).
 */
export function deriveOracleFromTranscript(transcript: readonly MissionTranscriptEntry[]): DerivedOracle | undefined {
  const lastFailedAction = [...transcript]
    .reverse()
    .find((t) => !t.actOk && t.descriptor !== undefined && !!t.op && ACTIONABLE_OPS.has(t.op) && !isEngineRefusal(t));
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

/** An expected HTTP status: a class (`2xx`) or an exact code (`201`) — the same shape `@jevitate/explore`'s `StatusSpec` carries, duck-typed here for the same reason `MissionTranscriptEntry` is. */
export type NetworkStatusSpec = { readonly class: 1 | 2 | 3 | 4 | 5 } | { readonly code: number };

/**
 * A failure oracle built from the mission's own failed `requestMade`/`responseStatus`
 * `--success` check (#119/#129): NEITHER has a `Recording` `Assertion` it can become (a network
 * check is not a DOM assertion) — it is replayed by re-running the Recording with the write
 * traffic captured, then re-evaluating THIS SAME check against what that replay sent, never by
 * appending a `Step` to the Recording. See `@jevitate/cli`'s `regression-api.ts`, which does the
 * actual capture/replay (it already depends on `@jevitate/explore`'s network-check evaluator and
 * page monitor; this package deliberately does not).
 */
export interface NetworkCheckOracle {
  readonly kind: "requestMade" | "responseStatus";
  readonly method: string;
  readonly pathGlob: string;
  readonly status?: NetworkStatusSpec;
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
