import type { EvidenceRef, FindingObservation, RunRecord } from "./extract.js";
import type { FindingCategory, FindingIdentity, RunMode, Severity } from "./identity.js";

/**
 * One deduped defect list across modes and runs (#139). Observations are merged when they share a
 * finding key, or when their engine fingerprints overlap (an adversarial defect's `related`
 * cascade: the same broken call can surface as its 5xx in one run and its page error in another).
 * Merging is transitive (union-find), and the merged defect's key is the lexicographically first
 * of its members' keys, so the same set of observations always yields the same key.
 */

export interface DefectRun {
  readonly runId: string;
  readonly path: string;
  readonly occurrences: number;
  readonly startedAt?: string;
  readonly targetBuild?: string;
}

export interface DefectMode {
  readonly mode: RunMode;
  readonly occurrences: number;
  readonly runs: readonly DefectRun[];
}

export interface ConsolidatedDefect {
  readonly key: string;
  /** Every member key (one unless observations were merged through their fingerprints). */
  readonly keys: readonly string[];
  readonly identity: FindingIdentity;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly title: string;
  readonly fingerprints: readonly string[];
  readonly modes: readonly DefectMode[];
  /** Total occurrences across every run. */
  readonly occurrences: number;
  /** Distinct runs that observed it. */
  readonly runCount: number;
  readonly firstSeen?: string;
  readonly lastSeen?: string;
  /** Evidence refs (step, screenshot, request), each tagged with its run; at most 20. */
  readonly evidence: ReadonlyArray<EvidenceRef & { readonly runId: string }>;
  /** Reproduction command (the verify-fix input) from the most recent run that has one. */
  readonly reproduce?: string;
  /** Some run saw it come and go (a hang reproduced k/N, verify-fix intermittent). */
  readonly intermittent: boolean;
}

interface Member {
  readonly run: RunRecord;
  readonly obs: FindingObservation;
}

class UnionFind {
  readonly #parent: number[] = [];
  add(): number {
    this.#parent.push(this.#parent.length);
    return this.#parent.length - 1;
  }
  find(i: number): number {
    let r = i;
    while (this.#parent[r] !== r) r = this.#parent[r] ?? r;
    let c = i;
    while (this.#parent[c] !== r) {
      const next = this.#parent[c] ?? r;
      this.#parent[c] = r;
      c = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.#parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { hard: 0, advisory: 1 };

function byTime(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}

/** Groups every observation in `runs` into deduped defects (hard first, then most runs, then key). */
export function consolidate(runs: readonly RunRecord[]): ConsolidatedDefect[] {
  const members: Member[] = [];
  const uf = new UnionFind();
  const byKey = new Map<string, number>();
  const byFingerprint = new Map<string, number>();
  for (const run of runs) {
    for (const obs of run.observations) {
      const i = uf.add();
      members.push({ run, obs });
      const k = byKey.get(obs.key);
      if (k === undefined) byKey.set(obs.key, i);
      else uf.union(i, k);
      // Only hard/advisory findings of the same category family merge through fingerprints.
      for (const fp of obs.related) {
        const tag = `${obs.identity.category}|${fp}`;
        const f = byFingerprint.get(tag);
        if (f === undefined) byFingerprint.set(tag, i);
        else uf.union(i, f);
      }
    }
  }
  const groups = new Map<number, Member[]>();
  members.forEach((m, i) => {
    const r = uf.find(i);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, [m]);
    else g.push(m);
  });
  const out = [...groups.values()].map(toDefect);
  return out.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.runCount - a.runCount || b.occurrences - a.occurrences || a.key.localeCompare(b.key),
  );
}

function toDefect(group: readonly Member[]): ConsolidatedDefect {
  const keys = [...new Set(group.map((m) => m.obs.key))].sort();
  const key = keys[0] ?? "";
  // The representative: the member whose own key is the defect's key, most recent run first.
  const sorted = [...group].sort((a, b) => byTime(b.run.startedAt, a.run.startedAt));
  const rep = sorted.find((m) => m.obs.key === key) ?? sorted[0];
  if (rep === undefined) throw new Error("consolidate: empty group");
  const modes = new Map<RunMode, Map<string, DefectRun>>();
  for (const { run, obs } of group) {
    const runsOfMode = modes.get(run.mode) ?? new Map<string, DefectRun>();
    // A run is identified by its result file (two dirs can hold runs with the same stem).
    const prev = runsOfMode.get(run.path);
    runsOfMode.set(run.path, {
      runId: run.runId,
      path: run.path,
      occurrences: (prev?.occurrences ?? 0) + obs.occurrences,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.targetBuild === undefined ? {} : { targetBuild: run.targetBuild }),
    });
    modes.set(run.mode, runsOfMode);
  }
  const modeList: DefectMode[] = [...modes.entries()]
    .map(([mode, rs]) => {
      const list = [...rs.values()].sort((a, b) => byTime(a.startedAt, b.startedAt));
      return { mode, runs: list, occurrences: list.reduce((n, r) => n + r.occurrences, 0) };
    })
    .sort((a, b) => a.mode.localeCompare(b.mode));
  const runIds = new Set(group.map((m) => m.run.path));
  const times = group.map((m) => m.run.startedAt).filter((t): t is string => t !== undefined).sort();
  const evidence = sorted.flatMap(({ run, obs }) => obs.evidence.map((e) => ({ ...e, runId: run.runId }))).slice(0, 20);
  const reproduce = sorted.find((m) => m.obs.reproduce !== undefined)?.obs.reproduce;
  const fingerprints = [...new Set(group.flatMap((m) => m.obs.related))].sort();
  return {
    key,
    keys,
    identity: rep.obs.identity,
    category: rep.obs.identity.category,
    severity: rep.obs.severity,
    title: rep.obs.title,
    fingerprints,
    modes: modeList,
    occurrences: modeList.reduce((n, m) => n + m.occurrences, 0),
    runCount: runIds.size,
    ...(times[0] === undefined ? {} : { firstSeen: times[0] }),
    ...(times.at(-1) === undefined ? {} : { lastSeen: times.at(-1) }),
    evidence,
    ...(reproduce === undefined ? {} : { reproduce }),
    intermittent: group.some((m) => m.obs.intermittent === true),
  };
}
