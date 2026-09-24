export { descriptorToTarget } from "./descriptor.js";
export { checkAssertion, readAssertionText, readAssertionEvidence, textIncludesCI, PostconditionFailed } from "./assertion.js";
export {
  evaluateVisual,
  isVisualAssertion,
  boxesOf,
  stylesOf,
  attrOf,
  DEFAULT_IN_VIEWPORT_MIN,
  type VisualAssertion,
  type VisualVerdict,
} from "./visual-state.js";
export { intersectionRatio, intersectionArea, boxesOverlap, sizeViolation, type Box, type SizeBounds } from "./geometry.js";
export { parseColor, parseNumber, styleChannel, compareStyle, type Rgba, type Comparison } from "./css-values.js";
export { installFlashRecorder, readFlashes, type FlashQuery, type FlashResult } from "./flash-recorder.js";
export { applyTextEdit, describeTextEdit } from "./rich-text.js";
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
