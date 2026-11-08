import { validateParamTypes, type Journey, type ParamIssue } from "@jevitate/journey";
import { EXIT_CODES } from "./exit-codes.js";
import { registerRunHooks, RunHookError } from "./journey-run-hooks.js";

/**
 * #796: typed Journey parameters at run time. `registerParamTypeHooks()` adds a `validateParams` run hook
 * that checks the supplied params against the Journey's declared parameter types (`validateParamTypes`)
 * before any fixture or browser opens. `runJourneyProgrammatically` is shared by CLI `journey run` and MCP
 * `run_journey` / `chain_journeys`, so one hook covers all of them.
 *
 * A mismatch refuses the run with `ParamTypeError` (`E_JOURNEY_PARAM_TYPE`). The error, its message and
 * `paramTypeRefusalBody` name parameters and expected types only, never a supplied value (it may be a secret).
 */

export const E_JOURNEY_PARAM_TYPE = "E_JOURNEY_PARAM_TYPE" as const;

/** A subclass of `RunHookError` so the run-hook runner rethrows it as is (it wraps any other error as E_RUN_HOOK). */
export class ParamTypeError extends RunHookError {
  readonly issues: readonly ParamIssue[];
  constructor(issues: readonly ParamIssue[]) {
    super("param-types", "validateParams", new Error(paramTypeMessage(issues)));
    this.issues = issues.map((i) => ({ name: i.name, expected: i.expected }));
    // `RunHookError.code` is the literal E_RUN_HOOK; this refusal carries its own code.
    Object.defineProperty(this, "name", { value: "ParamTypeError", enumerable: false });
    Object.defineProperty(this, "code", { value: E_JOURNEY_PARAM_TYPE, enumerable: true, writable: false });
    this.message = paramTypeMessage(issues);
  }
}

export function paramTypeMessage(issues: readonly ParamIssue[]): string {
  return `${E_JOURNEY_PARAM_TYPE}: ${issues.map((i) => `parameter "${i.name}" is not a valid ${i.expected}`).join("; ")}`;
}

/** The one body both surfaces report: CLI (error line and exit code) and MCP (error result). Never a value. */
export function paramTypeRefusalBody(err: ParamTypeError): {
  readonly error: "invalid_args";
  readonly code: typeof E_JOURNEY_PARAM_TYPE;
  readonly message: string;
  readonly issues: readonly ParamIssue[];
  readonly retryable: false;
  readonly exitCode: number;
} {
  return { error: "invalid_args", code: E_JOURNEY_PARAM_TYPE, message: err.message, issues: err.issues, retryable: false, exitCode: EXIT_CODES.usage };
}

/** Throws `ParamTypeError` when a supplied param does not match its declared type. */
export function assertParamTypes(journey: Journey, params: Readonly<Record<string, string>>): void {
  const issues = validateParamTypes(journey, params);
  if (issues.length > 0) throw new ParamTypeError(issues);
}

/** Registers the run hook; returns the unregistration. The manager calls it once at startup. */
export function registerParamTypeHooks(): () => void {
  return registerRunHooks("param-types", {
    validateParams: (ctx) => assertParamTypes(ctx.journey, ctx.params),
  });
}
