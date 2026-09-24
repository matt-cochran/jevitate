export { descriptorToTarget } from "./descriptor.js";
export { checkAssertion, readAssertionText, textIncludesCI, PostconditionFailed } from "./assertion.js";
export { runStep } from "./run-step.js";
export type { StepOutcome } from "./outcome.js";
export { RecordingInterpreter } from "./interpreter.js";
export type { InterpretResult } from "./interpret-result.js";
export { BufferingSink } from "./sink.js";
export type { RecordingSink, ToRecordingOptions } from "./sink.js";
export {
  resolveTarget,
  rungLocator,
  anchorLocator,
  descriptorLocator,
  ReplayTargetError,
  type ReplayTargetFailure,
  type ResolveTargetOptions,
} from "./resolve-target.js";
