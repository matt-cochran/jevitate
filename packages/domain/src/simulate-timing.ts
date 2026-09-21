import type { InteractionPolicy } from "./interaction-policy.js";
import { makeRng } from "./rng.js";
import { Pacer } from "./pacer.js";

export type PlannedStep =
  | { kind: "type"; label: string; text: string }
  | { kind: "click" | "navigate"; label: string }
  | { kind: "read"; label: string; chars: number };

export interface TimedStep {
  kind: string;
  label: string;
  delayMs: number;
}

export interface TimingProfile {
  steps: TimedStep[];
  totalMs: number;
}

export function simulateTiming(
  policy: InteractionPolicy,
  seed: number,
  script: PlannedStep[],
): TimingProfile {
  const rng = makeRng(seed);
  const pacer = new Pacer(rng);

  const steps: TimedStep[] = script.map((step) => {
    let delayMs: number;
    switch (step.kind) {
      case "type":
        delayMs = policy.typing
          ? pacer.typingDelays(step.text, policy.typing).reduce((n, d) => n + d, 0)
          : 0;
        break;
      case "click":
      case "navigate":
        delayMs = pacer.think(policy) + pacer.interInteraction(policy);
        break;
      case "read":
        delayMs = pacer.reading(step.chars, policy);
        break;
    }
    return { kind: step.kind, label: step.label, delayMs };
  });

  const totalMs = steps.reduce((n, s) => n + s.delayMs, 0);
  return { steps, totalMs };
}
