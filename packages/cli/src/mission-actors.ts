import type { Page } from "playwright";
import type { BrowserPort } from "@jevitate/playwright";
import type { ObserverSessions } from "@jevitate/explore";
import { invariantActors, type InvariantSpec } from "@jevitate/recording";
import { MultiRunArgsError, parseActorSpec, type Persona } from "./multi-run.js";

/**
 * Multi-actor missions (#147). `--actor <name>=<storageState>` (repeatable): the FIRST actor is the
 * primary — the only one the model drives; every other one is an OBSERVER that only runs the
 * spec's declared cross-actor checks (read-only probes and passive opens) from its own session.
 *
 * Guardrails:
 *  - each actor gets its OWN fresh browser context, seeded only from its own storageState file —
 *    cookies and storage are never copied between actors;
 *  - a storageState file's CONTENTS are never read here, never logged and never written into an
 *    artifact: only its path is kept (as `--storage-state`'s own path always was);
 *  - observers are opened lazily, on the first check that needs one, and never handed to a model.
 */

export interface MissionActors {
  /** The primary actor (its storageState seeds the mission's own session). */
  readonly primary: Persona;
  /** Every other actor, in flag order. */
  readonly observers: readonly Persona[];
}

/** Parses `--actor` flags (none → null). Names must be distinct. Throws `MultiRunArgsError`. */
export function resolveMissionActors(specs: readonly string[], cwd: string = process.cwd()): MissionActors | null {
  if (specs.length === 0) return null;
  const actors = specs.map((s) => parseActorSpec(s, cwd));
  const seen = new Set<string>();
  for (const a of actors) {
    if (seen.has(a.name)) throw new MultiRunArgsError(`actor ${a.name} is declared twice`);
    seen.add(a.name);
  }
  const [primary, ...observers] = actors as [Persona, ...Persona[]];
  return { primary, observers };
}

/**
 * Refuses a spec whose cross-actor checks name the PRIMARY (an observer must be someone else) —
 * unregistered actors are refused by the spec validation itself (`observers`).
 */
export function checkActorsAgainstSpec(actors: MissionActors | null, spec: InvariantSpec | undefined): void {
  if (spec === undefined || actors === null) return;
  for (const name of invariantActors(spec)) {
    if (name === actors.primary.name) {
      throw new MultiRunArgsError(`invariants: actor ${name} is the primary; a cross-actor check runs as another --actor`);
    }
  }
}

/**
 * The observers' sessions: one FRESH context per observer (from `portFactory`, with the mission's
 * launch options but ONLY that observer's storageState), opened on first use, closed by `close()`.
 */
export function observerSessions(
  portFactory: () => BrowserPort,
  launch: Omit<Parameters<BrowserPort["open"]>[0], "storageState">,
  observers: readonly Persona[],
): ObserverSessions {
  const open = new Map<string, Promise<{ page: Page; close(): Promise<void> }>>();
  return {
    page: async (name) => {
      const actor = observers.find((o) => o.name === name);
      if (actor === undefined) throw new Error(`no observer actor named ${name}`);
      let session = open.get(name);
      if (session === undefined) {
        const { storageState: _primaryState, ...base } = launch as Parameters<BrowserPort["open"]>[0];
        session = portFactory().open({ ...base, storageState: actor.storageState });
        open.set(name, session);
      }
      return (await session).page;
    },
    close: async () => {
      const sessions = [...open.values()];
      open.clear();
      await Promise.all(sessions.map(async (s) => (await s.catch(() => null))?.close().catch(() => undefined)));
    },
  };
}

/** What a result persists about its actors: names and storageState PATHS — never contents. */
export function persistedActors(actors: MissionActors): Array<{ readonly name: string; readonly storageStatePath: string; readonly role: "primary" | "observer" }> {
  return [
    { name: actors.primary.name, storageStatePath: actors.primary.storageState, role: "primary" },
    ...actors.observers.map((o) => ({ name: o.name, storageStatePath: o.storageState, role: "observer" as const })),
  ];
}
