import { AsyncLocalStorage } from "node:async_hooks";
import type { JobVerdict } from "@jevitate/adjudicator";
import type { DoneCheckPolicy } from "@jevitate/domain";

/**
 * H5 (0.30.0 independent check): the done-check scope one Journey run reads its job's done check in
 * (`DoneCheckRun`, journey-done-check-hook.ts). It lives in this small module so the run itself
 * (`runJourneyProgrammatically`, which writes a self-heal run's result record) can read the verdict
 * the hooks decided without importing the hook module and its browser and catalog dependencies.
 */
export interface DoneCheckScopeState {
  /** The verdict the hooks decided so far; undefined when no hook ran. */
  readonly job: JobVerdict | undefined;
  /** The policy the surface that opened the scope folds the verdict with. */
  readonly policy: DoneCheckPolicy;
}

export const doneCheckScopeStorage = new AsyncLocalStorage<DoneCheckScopeState>();

/** The done-check scope of the run in progress, if a surface opened one. */
export function currentDoneCheckScope(): DoneCheckScopeState | undefined {
  return doneCheckScopeStorage.getStore();
}
