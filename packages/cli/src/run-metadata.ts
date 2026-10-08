import { AsyncLocalStorage } from "node:async_hooks";
import type { RunTags } from "@jevitate/domain";

/**
 * #426 run metadata: the `--tag key=value` tags a run was given, and (for a run a sweep or a persona
 * multi-run started) the persona it ran as. Held in an AsyncLocalStorage scope around the command's
 * action, so every place a run result leaves the process — the persisted `<stem>.result.json`
 * (`writeMissionResult`, `check`'s item results), the run index line and the emitted `--json`
 * envelope — stamps the SAME metadata without threading it through every strategy runner. Runs a
 * sweep starts concurrently in one process each get their own scope.
 *
 * Tags are never redacted (they are plain metadata): docs/cli.md says a tag must never carry a secret.
 */
export interface RunMetadata {
  readonly tags: RunTags;
  /** The persona name (a sweep target's / multi-run persona's), never a storage-state's contents. */
  readonly persona?: string;
}

const scope = new AsyncLocalStorage<RunMetadata>();

/** The metadata of the run executing here (`undefined` outside any tagged command). */
export function currentRunMetadata(): RunMetadata | undefined {
  return scope.getStore();
}

/** Runs `fn` with `meta` merged over the enclosing scope's (own tags win; the persona is kept unless given). */
export function withRunMetadata<T>(meta: Partial<RunMetadata>, fn: () => T): T {
  const outer = scope.getStore();
  const persona = meta.persona ?? outer?.persona;
  const merged: RunMetadata = { tags: { ...(outer?.tags ?? {}), ...(meta.tags ?? {}) }, ...(persona === undefined ? {} : { persona }) };
  return scope.run(merged, fn);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The result with the run metadata stamped on: `tags` (when any) and the structured target
 * (`target.startUrl` — the run's seed URL —, `target.persona`, `target.strategy`). Values the result
 * already carries win (a runner that knows better is never overwritten). Non-objects pass through.
 */
export function stampRunMetadata<T>(result: T, meta: RunMetadata | undefined = currentRunMetadata()): T {
  if (!isRecord(result)) return result;
  const out: Record<string, unknown> = { ...result };
  const tags = { ...(meta?.tags ?? {}), ...(isRecord(result.tags) ? (result.tags as Record<string, string>) : {}) };
  if (Object.keys(tags).length > 0) out.tags = tags;
  if (isRecord(result.target)) {
    const t = result.target;
    const strategy = typeof result.strategy === "string" ? result.strategy : typeof result.mode === "string" ? result.mode : undefined;
    out.target = {
      ...t,
      ...(t.startUrl === undefined && typeof t.seedUrl === "string" ? { startUrl: t.seedUrl } : {}),
      ...(t.persona === undefined && meta?.persona !== undefined ? { persona: meta.persona } : {}),
      ...(t.strategy === undefined && strategy !== undefined ? { strategy } : {}),
    };
  }
  return out as T;
}
