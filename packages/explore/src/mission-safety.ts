import { writeClassifier } from "@jevitate/recording";
import type { PageMonitor } from "./page-monitor.js";
import { SafetyPolicy, type SafetyConfig, type SafetyVerdict } from "./safety.js";
import { SideEffectLog, type SideEffect } from "./side-effects.js";
import type { Control } from "./snapshot.js";

/**
 * The safety policy and side-effect record of a model-free mission (coverage/exploratory, feature,
 * adversarial — #116): one object each frontier loop consults before it clicks, marks before it
 * acts, and reports from. The goal loop (`explore`) wires the same two pieces itself.
 */
export class MissionSafety {
  readonly policy: SafetyPolicy;
  readonly #log: SideEffectLog;
  readonly #refused = new Set<string>();

  constructor(cfg: SafetyConfig = {}, opts: { readonly goal?: string; readonly now?: () => number } = {}) {
    this.policy = new SafetyPolicy(cfg, opts.goal === undefined ? {} : { goal: opts.goal });
    this.#log = new SideEffectLog({
      isWrite: writeClassifier(cfg.readRequests === undefined ? {} : { readRequests: cfg.readRequests }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
  }

  /** Captures the writes on this page (call again with the new page's monitor after a reset). */
  attach(monitor: PageMonitor): void {
    this.#log.attach(monitor);
  }

  /**
   * May this op on this control run? Only a click can end the session or fire the action a name
   * promises; typing/selecting is always allowed. `first` is true the first time a control (by
   * role+name) is refused, so a loop records each refusal once.
   */
  gate(op: string, control: Pick<Control, "name" | "role" | "descriptor"> | null): (SafetyVerdict & { readonly first: boolean }) | null {
    if (op !== "click" || control === null) return null;
    const v = this.policy.refuses(control);
    if (v === null) return null;
    const id = `${control.role}|${control.name}`;
    const first = !this.#refused.has(id);
    this.#refused.add(id);
    return { ...v, first };
  }

  /**
   * A frontier candidate the policy refuses is never enqueued (#186): it would only cost a reset
   * and a step to be refused later. True when withheld; `onFirst` records the refusal, once per control.
   */
  withholds(op: string, control: Pick<Control, "name" | "role" | "descriptor">, onFirst: (reason: string) => void): boolean {
    const unsafe = this.gate(op, control);
    if (unsafe === null) return false;
    if (unsafe.first) onFirst(unsafe.reason);
    return true;
  }

  /** An action is about to be dispatched (its writes are attributed to `step`). */
  mark(step: number, op: string, control: Pick<Control, "name" | "summary" | "role"> | null): void {
    const label = control === null ? op : control.name || control.summary;
    this.#log.mark(step, label, control === null ? null : this.policy.riskOf(control));
  }

  /** The result fields: the writes fired, and how many past the listed cap. Stops capturing. */
  result(): { readonly sideEffects: SideEffect[]; readonly sideEffectsTruncated?: number } {
    const { sideEffects, truncated } = this.#log.entries();
    this.#log.close();
    return { sideEffects, ...(truncated > 0 ? { sideEffectsTruncated: truncated } : {}) };
  }

  /** The controls refused so far (their accessible names), for the evidence. */
  refused(): string[] {
    return [...this.#refused].map((id) => id.slice(id.indexOf("|") + 1));
  }
}
