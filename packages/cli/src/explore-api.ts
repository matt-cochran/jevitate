import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgmentPort, GenerationPort, CredentialKey } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { Assertion, TargetDescriptor } from "@jevitate/recording";
import {
  runGoalBasedMission,
  runFeatureMission,
  assertAuthorizedExploreTarget,
  normalizeAllowlist,
  type Bounds,
  type GoalBasedOutcome,
  type StopReason,
  type CapabilityScope,
  type FeatureRunResult,
} from "@jevitate/explore";
import { resolveDataDir } from "./data-dir.js";

/**
 * The programmatic surface behind `jevitate explore` — wires a real Playwright
 * `Page` + gateways to `@jevitate/explore`'s goal-based mission, then persists
 * the emitted `Recording` under `~/.jevitate/recordings`.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium. Gateways are
 * injected (fakes in tests / live wiring in `program.ts`), so this file needs
 * no keys or network to be unit-tested.
 */

export interface RunExplorationOptions {
  readonly url: string;
  readonly goal: string;
  readonly successAssertion: Assertion;
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /** Where the Recording is written. Default `~/.jevitate/recordings`. */
  readonly outDir?: string;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** ISO clock for the recording filename. Default `Date.now()`. */
  readonly nowIso?: () => string;
}

export interface RunExplorationResult {
  readonly outcome: GoalBasedOutcome;
  readonly assertionPassed: boolean;
  readonly stop: StopReason;
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  readonly recordingPath: string;
}

export async function runExploration(opts: RunExplorationOptions): Promise<RunExplorationResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const profileDir = await mkdtemp(join(tmpdir(), "jevitate-explore-"));
  const session = await port.open({
    profileDir,
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
  });

  try {
    const actor = CastActor.named("explorer").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const mission = await runGoalBasedMission({
      actor,
      judge: opts.judge,
      gen: opts.gen,
      goal: opts.goal,
      allowlist: opts.allowlist,
      startUrl: opts.url,
      successAssertion: opts.successAssertion,
      bounds: opts.bounds,
      secrets: opts.secrets,
      site: origin,
    });

    const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
    await mkdir(outDir, { recursive: true });
    const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
    const recordingPath = join(outDir, `explore-${iso.replace(/[:.]/g, "-")}.json`);
    await writeFile(recordingPath, `${JSON.stringify(mission.recording, null, 2)}\n`, "utf8");

    return {
      outcome: mission.outcome,
      assertionPassed: mission.assertionPassed,
      stop: mission.run.stop,
      finalUrl: mission.finalUrl,
      decisions: mission.run.decisions,
      actions: mission.run.actions,
      recordingPath,
    };
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

/**
 * The programmatic surface behind `jevitate explore --feature <name>` — the
 * capability-scoped feature-testing mission (ticket #2, paired site ticket
 * #11). Model-free by design, so unlike `runExploration` it needs no gateways.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium.
 */
export interface RunFeatureCliMissionOptions {
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly capability: string;
  readonly routeGlobs: readonly string[];
  readonly profileDir: string;
  readonly headless?: boolean;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
}

export async function runFeatureCliMission(opts: RunFeatureCliMissionOptions): Promise<FeatureRunResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  const scope: CapabilityScope = { name: opts.capability, originAllowlist: opts.allowlist, routeGlobs: opts.routeGlobs };

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const session = await portFactory().open({
    profileDir: opts.profileDir,
    headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
  });
  try {
    const actor = CastActor.named("feature-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    return await runFeatureMission({
      page: session.page,
      actor,
      seedUrl: opts.seedUrl,
      allowlist: opts.allowlist,
      scope,
    });
  } finally {
    await session.close();
  }
}

/** Injectable wiring for the `explore` CLI command (all optional). */
export interface ExploreCliDeps {
  /** Injected judgment gateway (tests). */
  judge?: JudgmentPort;
  /** Injected generation gateway (tests). */
  gen?: GenerationPort;
  browserPortFactory?: () => BrowserPort;
  env?: Record<string, string | undefined>;
  localConfig?: Partial<Record<CredentialKey, string>>;
}

/**
 * Compact `--success` assertion spec parser. Supported forms:
 *   urlIncludes:<text>
 *   visible:<descriptor>
 *   textIncludes:<descriptor>|<text>
 *   count:<descriptor>|min=<n>,max=<n>
 * where <descriptor> is `k=v` pairs joined by `;` over
 * testId/role/name/label/text/css.
 */
export function parseAssertionSpec(spec: string): Assertion {
  const ci = spec.indexOf(":");
  if (ci === -1) throw new Error(`invalid --success spec ${JSON.stringify(spec)}; expected "<kind>:<...>"`);
  const kind = spec.slice(0, ci);
  const rest = spec.slice(ci + 1);

  switch (kind) {
    case "urlIncludes": {
      if (rest === "") throw new Error("urlIncludes requires a text (urlIncludes:/path)");
      return { kind: "urlIncludes", text: rest };
    }
    case "visible":
      return { kind: "visible", target: parseDescriptorSpec(rest) };
    case "textIncludes": {
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error('textIncludes requires "<descriptor>|<text>"');
      return { kind: "textIncludes", target: parseDescriptorSpec(rest.slice(0, bar)), text: rest.slice(bar + 1) };
    }
    case "count": {
      const bar = rest.indexOf("|");
      const descPart = bar === -1 ? rest : rest.slice(0, bar);
      const bounds = bar === -1 ? "" : rest.slice(bar + 1);
      const target = parseDescriptorSpec(descPart);
      const out: Assertion = { kind: "count", target };
      for (const pair of bounds.split(",")) {
        const [k, v] = pair.split("=");
        if (k === "min" && v) (out as { min?: number }).min = Number(v);
        if (k === "max" && v) (out as { max?: number }).max = Number(v);
      }
      return out;
    }
    default:
      throw new Error(`unsupported assertion kind ${JSON.stringify(kind)}`);
  }
}

function parseDescriptorSpec(s: string): TargetDescriptor {
  const d: TargetDescriptor = {};
  const keys = ["testId", "role", "name", "label", "text", "css"] as const;
  for (const pair of s.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if ((keys as readonly string[]).includes(k) && v !== "") {
      (d as Record<string, string>)[k] = v;
    }
  }
  if (!(d.testId || d.role || d.label || d.text || d.css)) {
    throw new Error(`descriptor spec ${JSON.stringify(s)} has no usable selector`);
  }
  return d;
}

/**
 * The authorized-origins allowlist for a run: explicit `--allow` origins when
 * given, otherwise the target URL's own origin (you asked to explore it). An
 * unparseable URL yields an empty allowlist → the guard fails closed.
 */
export function resolveExploreAllowlist(url: string, allow: readonly string[]): string[] {
  if (allow.length > 0) return [...allow];
  return normalizeAllowlist([url]);
}
