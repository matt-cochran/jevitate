import { redactText, redactUrl } from "@jevitate/ai-core";
import { fingerprintMarker, targetsFor, contentHash, type Attribution, type IssueDraft } from "@jevitate/domain";
import type { TranscriptEntry } from "./transcript.js";
import type { AdversarialDefect } from "./missions/adversarial.js";
import type { CrashReport } from "./crash-report.js";
import type { HangFinding } from "./hang-repro.js";
import type { HostPressure } from "./host-pressure.js";
import { attributeCrash } from "@jevitate/domain";
import { jevitateCodeRoots } from "./crash-report.js";

/**
 * Ready-to-file issue drafts (owner ruling 3): a title and a Markdown body with the repro steps,
 * the environment, the evidence and the fingerprint marker used for dedup. Every draft passes
 * through the shared redaction seam as its LAST step — the title and the whole body — so a
 * registered secret (`--secret`) can never appear in a draft, whatever field it hid in.
 */

export interface DraftEnvironment {
  /** e.g. `linux x64`, `win32 x64`, `darwin arm64`. */
  readonly os: string;
  readonly node: string;
  readonly browser?: string;
  readonly jevitateVersion?: string;
  /** The build this run came from (issue #83): which commit, and when it was built. "unknown"
   *  when the build couldn't determine one — never fabricated. Lets two results from a
   *  `npm link`ed working tree rebuilt mid-session be told apart. */
  readonly commit?: string;
  readonly builtAt?: string;
  /** The system under test's origin. */
  readonly target: string;
}

export interface DraftContext {
  readonly environment: DraftEnvironment;
  /** Where the full Recording/transcript were written (for the reader to replay). */
  readonly recordingPath?: string;
  readonly transcriptPath?: string;
  /** The `verify-fix` command that re-checks this finding. */
  readonly verifyCommand?: string;
  readonly secrets: readonly string[];
}

/** The portable environment line (no OS-specific APIs: `process.platform`/`arch`/`version`). */
export function currentEnvironment(
  target: string,
  extra: { browser?: string; jevitateVersion?: string; commit?: string; builtAt?: string } = {},
): DraftEnvironment {
  return {
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    target,
    ...(extra.browser === undefined ? {} : { browser: extra.browser }),
    ...(extra.jevitateVersion === undefined ? {} : { jevitateVersion: extra.jevitateVersion }),
    ...(extra.commit === undefined ? {} : { commit: extra.commit }),
    ...(extra.builtAt === undefined ? {} : { builtAt: extra.builtAt }),
  };
}

/** The host-pressure evidence line (the sample admission control takes). */
function hostLine(host: HostPressure | undefined): string {
  if (host === undefined) return "- Host pressure: not sampled";
  if (host.sample === null) return `- Host pressure: could not be sampled (${host.error ?? "unknown"})`;
  return host.overThreshold !== null
    ? `- Host pressure: **host under resource pressure** — ${host.overThreshold}`
    : `- Host pressure: within thresholds (${host.sample.source})`;
}

function stepLine(e: TranscriptEntry): string {
  const who = e.strategy !== undefined ? e.strategy : e.chosenBy;
  const action = e.op === null ? "(no action)" : e.target === null ? e.op : `${e.op} ${e.target}`;
  const outcome = e.actOk ? "" : " — did not land";
  const reason = e.reason === undefined ? "" : ` — ${e.reason}`;
  return `${e.step}. [${who}] ${action} on \`${e.url}\`${outcome}${reason}`;
}

function environmentSection(env: DraftEnvironment): string {
  const jevitateLine =
    env.jevitateVersion === undefined
      ? []
      : [`- jevitate: ${env.jevitateVersion}${env.commit === undefined ? "" : ` (commit ${env.commit}${env.builtAt === undefined ? "" : `, built ${env.builtAt}`})`}`];
  return [
    "## Environment",
    `- Target: \`${env.target}\``,
    `- OS: ${env.os}`,
    `- Node: ${env.node}`,
    ...(env.browser === undefined ? [] : [`- Browser: ${env.browser}`]),
    ...jevitateLine,
  ].join("\n");
}

function artifactSection(ctx: DraftContext): string {
  const lines = ["## Artifacts"];
  if (ctx.recordingPath !== undefined) lines.push(`- Recording: \`${ctx.recordingPath}\``);
  if (ctx.transcriptPath !== undefined) lines.push(`- Transcript: \`${ctx.transcriptPath}\``);
  if (ctx.verifyCommand !== undefined) lines.push(`- Verify a fix: \`${ctx.verifyCommand}\``);
  return lines.length > 1 ? lines.join("\n") : "";
}

/** The final, redacted draft. Redaction is applied to the assembled text, so nothing escapes it. */
function finalize(
  fingerprint: string,
  title: string,
  sections: readonly string[],
  labels: readonly string[],
  attribution: Attribution,
  secrets: readonly string[],
): IssueDraft {
  const body = [...sections.filter((s) => s !== ""), fingerprintMarker(fingerprint)].join("\n\n");
  return {
    fingerprint,
    title: redactText(redactUrl(title), secrets),
    body: redactText(redactUrl(body), secrets),
    labels,
    attribution,
    targets: targetsFor(attribution),
  };
}

/** A hard-signal defect found by the adversarial mission. Always the system under test's. */
export function draftForDefect(defect: AdversarialDefect, ctx: DraftContext): IssueDraft {
  const summary = [
    `jevitate's adversarial mission observed **${defect.title}** on \`${defect.route}\`.`,
    `Fingerprint \`${defect.fingerprint}\` · first seen at step ${defect.firstSeenStep} · ${defect.occurrences} occurrence(s) in this run.`,
  ].join("\n\n");
  const repro = [
    "## Steps to reproduce",
    ...defect.repro.steps.map(stepLine),
    "",
    `Replay the Recording up to flat step index ${defect.repro.recordingStepIndex} to reach the same state.`,
  ].join("\n");
  const evidence = [
    "## Evidence",
    ...(defect.invariantReason === undefined ? [] : [`- Invariant: ${defect.invariantReason}`]),
    ...defect.signals.map((s) => `- \`${s.kind}\`: ${s.detail}`),
  ].join("\n");
  const triage =
    defect.triage.status === "available"
      ? `## Triage (model-generated, advisory)\n${defect.triage.summary}\n\nLikely cause: ${defect.triage.likelyCause}`
      : `## Triage\nUnavailable: ${defect.triage.reason}`;
  return finalize(
    defect.fingerprint,
    `[jevitate] ${defect.title}`,
    [summary, repro, evidence, triage, environmentSection(ctx.environment), artifactSection(ctx)],
    ["jevitate", "defect"],
    "system-under-test",
    ctx.secrets,
  );
}

/** A crashed run: attributed by evidence; `uncertain` drafts are routed to both repos. */
export function draftForCrash(crash: CrashReport, steps: readonly TranscriptEntry[], ctx: DraftContext): IssueDraft {
  // A crash's identity: where it happened in the product's terms (attribution + failure kind +
  // message class), never the run's timestamps.
  const firstLine = crash.failure.message.split("\n")[0] ?? crash.failure.message;
  const fingerprint = contentHash(
    `crash|${crash.attribution.attribution}|${crash.failure.kind}|${firstLine.replace(/\d+/g, "<n>")}`,
  ).slice(0, 16);
  const who =
    crash.attribution.attribution === "jevitate"
      ? "jevitate itself"
      : crash.attribution.attribution === "system-under-test"
        ? "the system under test"
        : "an uncertain party (filed to both jevitate and the system under test)";
  const summary = [
    `A jevitate mission crashed (\`${crash.failure.kind}\`): ${firstLine}`,
    `Attributed to **${who}** because ${crash.attribution.reasons.join("; ")}.`,
  ].join("\n\n");
  const repro = ["## Steps up to the crash", ...(steps.length === 0 ? ["(the crash happened before the first step)"] : steps.map(stepLine))].join("\n");
  const heap = crash.evidence.heapSamples;
  const evidence = [
    "## Evidence",
    `- Page crashed: ${crash.evidence.pageCrashed}`,
    `- Browser disconnected: ${crash.evidence.browserDisconnected}`,
    `- Renderer out of memory: ${crash.evidence.rendererOom}`,
    `- Hang: ${crash.evidence.hang}`,
    hostLine(crash.host),
    heap.length === 0
      ? "- JS heap: not readable"
      : `- JS heap by step: ${heap.map((h) => `${h.step}: ${(h.usedBytes / 1_048_576).toFixed(1)} MB`).join(", ")}`,
    ...(crash.failure.stack === undefined ? [] : ["", "```", crash.failure.stack, "```"]),
  ].join("\n");
  return finalize(
    fingerprint,
    `[jevitate] Mission crashed: ${firstLine.slice(0, 100)}`,
    [summary, repro, evidence, environmentSection(ctx.environment), artifactSection(ctx)],
    ["jevitate", "crash"],
    crash.attribution.attribution,
    ctx.secrets,
  );
}

/**
 * A hang, filed like a defect. Attributed by the same evidence rule as a crash: a hang is the
 * system under test's behaviour (the rule's `hang` signal), so it routes there.
 */
export function draftForHang(hang: HangFinding, ctx: DraftContext): IssueDraft {
  const host = hang.signal.host;
  const attribution = attributeCrash(
    {
      pageCrashed: false,
      browserDisconnected: false,
      rendererOom: false,
      heapSamples: [],
      hang: true,
      hangKind: hang.hangKind,
      ...(host?.overThreshold ? { hostUnderPressure: host.overThreshold } : {}),
    },
    jevitateCodeRoots(),
  );
  const r = hang.reproduction;
  const summary = [
    `jevitate observed a **hang** (\`${hang.hangKind}\`) on \`${hang.route}\`: ${hang.signal.detail}.`,
    `Reproduced **${r.reproduced}/${r.attempts}** in fresh browser contexts (${r.status}; ${r.ran} of the replays ran — a replay that could not run is no evidence either way). Fingerprint \`${hang.fingerprint}\`.`,
  ].join("\n\n");
  const repro = [
    "## Steps to reproduce",
    ...hang.repro.steps.map(stepLine),
    "",
    `Replay the Recording up to flat step index ${hang.repro.recordingStepIndex}, then wait: the page does not settle/progress.`,
  ].join("\n");
  const evidence = [
    "## Evidence",
    ...(hang.signal.pending.length === 0
      ? ["- Pending requests: none"]
      : hang.signal.pending.map((p) => `- Pending: \`${p.endpoint}\` for ${Math.round(p.ageMs)}ms`)),
    `- Last page state: ${hang.signal.lastState.controls.length} controls${
      hang.signal.lastState.controls.length === 0 ? "" : ` (${hang.signal.lastState.controls.slice(0, 12).join("; ")})`
    }`,
    ...(hang.signal.heapBytes === undefined ? [] : [`- JS heap: ${(hang.signal.heapBytes / 1_048_576).toFixed(1)} MB`]),
    hostLine(host),
    ...(attribution.attribution === "uncertain" ? [`- Attribution: uncertain — ${attribution.reasons.join("; ")}`] : []),
    "",
    "### Replays",
    ...r.runs.map((run, i) => `${i + 1}. ${run.reproduced ? "reproduced" : "did not reproduce"} (replay ${run.replay}): ${run.detail}`),
  ].join("\n");
  return finalize(
    hang.fingerprint,
    `[jevitate] Hang (${hang.hangKind}) on ${hang.route}`,
    [summary, repro, evidence, environmentSection(ctx.environment), artifactSection(ctx)],
    ["jevitate", "hang"],
    attribution.attribution,
    ctx.secrets,
  );
}
