import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Command } from "commander";
import * as clack from "@clack/prompts";
import { type SitePolicy } from "@jevitate/domain";
import {
  RecordingSchema,
  AuthoringTakeSchema,
  PostdocDecisionsSchema,
  promoteToVariable,
  diffTakes,
  applyPostdoc,
  flattenBaseFillSteps,
  fitInteractionPolicy,
  type Recording,
  type AuthoringRecording,
  type ColumnClass,
  type PostdocDecision,
} from "@jevitate/recording";
import { BindingProposalError, proposeBindings, valueHint, type AuthoringTake, type BindingProposal } from "@jevitate/explore";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { ok, fail } from "./envelope.js";
import { nonNegativeIntArg } from "./cli-args.js";
import { type CliDeps, emitJson, resolveJourneysDir } from "./cli-shared.js";
import { inMcpInvocation } from "./approval-provenance.js";

/** Registers `jevitate recording`: `promote|diff|fit|postdoc|propose`. */
export function registerRecordingCommands(program: Command, deps: CliDeps): void {
  /**
   * Reads one "take file" for `recording diff`/`recording postdoc` (#124): a JSON object written
   * by `jevitate record` — `{ recording, values }` (`AuthoringTakeSchema`). A raw `Recording` — the
   * kind `explore`/`explore-author-journey`/a usability run emits directly, `{version, site, pages,
   * ...}` at the TOP level, no `recording`/`values` wrapper — is a common, easy mistake to hand
   * here; `AuthoringTakeSchema`'s `.strict()` rejects it with an opaque `Unrecognized keys: version,
   * site, intent, pages` zod dump. Detected BEFORE the schema parse so the caller gets a message
   * that names the actual problem and how to fix it, not a zod dump.
   */
  async function readTakeJson(file: string): Promise<unknown> {
    const raw = await readFile(file, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`'${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (json !== null && typeof json === "object" && !Array.isArray(json) && "pages" in json && !("recording" in json)) {
      throw new Error(
        `'${file}' looks like a Recording (it has a top-level "pages"), not a take file. ` +
          `'recording diff'/'recording postdoc'/'recording propose' need a take file written by 'jevitate record' — shape ` +
          `{ recording, values } — not a raw Recording from 'explore', 'explore-author-journey', or a ` +
          `usability run. Wrap it as { "recording": <the Recording>, "values": {} } if you want to ` +
          `diff/postdoc it anyway.`,
      );
    }
    return json;
  }

  async function readAuthoringTake(file: string): Promise<AuthoringRecording> {
    const parsed = AuthoringTakeSchema.parse(await readTakeJson(file));
    return { recording: parsed.recording, values: new Map(Object.entries(parsed.values)) };
  }

  /**
   * Reads one Recording for `recording promote`/`recording fit` (#564): accepts EITHER a raw
   * `Recording` (as before) OR the `{recording, values}` take file `jevitate record` writes —
   * unwrapping `.recording` in the latter case, so a take recorded for `diff`/`postdoc` can also be
   * promoted/fitted without hand-editing. The `values` side-channel is deliberately discarded: these
   * two commands operate on the persisted artifact only.
   */
  async function readRecordingOrTake(file: string): Promise<Recording> {
    const raw = await readFile(file, "utf8");
    const json: unknown = JSON.parse(raw);
    if (json !== null && typeof json === "object" && !Array.isArray(json) && "recording" in json) {
      return AuthoringTakeSchema.parse(json).recording;
    }
    return RecordingSchema.parse(json);
  }

  const recording = program.command("recording").description("inspect and edit recorded takes (promote, edit steps, diff, postdoc)");

  recording
    .command("promote <file>")
    .requiredOption("--page <n>", "page index", nonNegativeIntArg)
    .requiredOption("--step <n>", "step index within the page", nonNegativeIntArg)
    .requiredOption("--var <name>", "variable name to bind")
    .action(async function (this: Command, file: string) {
      const { page, step, var: varName } = this.opts<{ page: string; step: string; var: string }>();
      try {
        const rec = await readRecordingOrTake(file);
        const result = promoteToVariable(rec, { page: Number(page), step: Number(step) }, varName);
        program.configureOutput().writeOut?.(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = 0;
      } catch (err) {
        emitJson(program, fail("E_INVALID_RECORDING", String(err)));
      }
    });

  recording
    .command("diff <takeA> <takeB> [more...]")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, takeA: string, takeB: string, more: string[]) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const files = [takeA, takeB, ...more];
        const takes: AuthoringRecording[] = await Promise.all(files.map(readAuthoringTake));
        const diffResult = diffTakes(takes);
        // A take's values are what a person typed: over MCP they never reach the model (only hints).
        const envelope = ok(inMcpInvocation() ? redactDiffForModel(diffResult) : diffResult);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          diffResult.columns.forEach((col: ColumnClass, i: number) => {
            const type = col.inferredType ? `, type=${col.inferredType}` : "";
            out?.(
              `column ${i}: ${col.kind} (confidence ${col.confidence.toFixed(2)}${type}) values=${JSON.stringify(col.values)}\n`
            );
          });
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INVALID_TAKE", String(err)));
      }
    });

  recording
    .command("fit <file>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, file: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const rec = await readRecordingOrTake(file);
        const interaction = fitInteractionPolicy(rec);
        const policy: SitePolicy = { version: "1.0.0", interaction };
        if (json) {
          emitJson(program, ok(policy));
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(policy, null, 2)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INVALID_RECORDING", String(err)));
      }
    });

  recording
    .command("postdoc <take> [more...]")
    .option("--decisions <file>", "path to a PostdocDecision[] JSON file (non-interactive mode)")
    .option("--out <file>", "write the resulting Recording to this file instead of stdout")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, take: string, more: string[]) {
      const { decisions: decisionsFile, out, json } = this.opts<{
        decisions?: string;
        out?: string;
        json?: boolean;
      }>();
      try {
        const files = [take, ...more];
        const takes: AuthoringRecording[] = await Promise.all(files.map(readAuthoringTake));
        const diff = diffTakes(takes);

        let decisions: PostdocDecision[];
        if (decisionsFile !== undefined) {
          decisions = await loadDecisions(decisionsFile);
        } else {
          decisions = await promptForDecisions(takes[0]);
        }

        const result = applyPostdoc(takes[0], diff, decisions);

        if (out !== undefined) {
          await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        }
        if (json) {
          emitJson(program, ok(inMcpInvocation() ? redactRecordingForModel(result) : result));
        } else if (out === undefined) {
          program.configureOutput().writeOut?.(`${JSON.stringify(result, null, 2)}\n`);
          process.exitCode = 0;
        } else {
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof DecisionsParseError) {
          emitJson(program, fail("E_INVALID_DECISIONS", String(err.cause)));
        } else {
          emitJson(program, fail("E_INVALID_TAKE", String(err)));
        }
      }
    });

  recording
    .command("propose <take> [more...]")
    .description(
      "propose parameters, outputs, {var} checks, credential handbacks and where to stop from two or more takes of the same flow (#566); saves an UNPROMOTED draft Journey for review — ambiguities stay for a person to decide",
    )
    .option("--out <file>", "write the draft Journey JSON to this file instead of saving it in the journeys store")
    .option("--no-draft", "propose only: build and save no draft Journey")
    .option("--id <id>", "the draft Journey's id (default: proposed-draft)")
    .option("--name <name>", "the draft Journey's name (default: the first take's intent)")
    .option("--journeys-dir <dir>", "journeys store directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, take: string, more: string[]) {
      const o = this.opts<{ out?: string; draft: boolean; id?: string; name?: string; journeysDir?: string; json?: boolean }>();
      let takes: AuthoringTake[];
      try {
        takes = (await Promise.all([take, ...more].map(readTakeJson))) as AuthoringTake[];
      } catch (err) {
        emitJson(program, fail("E_INVALID_TAKE", err instanceof Error ? err.message : String(err)));
        return;
      }
      let proposal: BindingProposal;
      try {
        proposal = proposeBindings(takes, {
          ...(o.id === undefined ? {} : { id: o.id }),
          ...(o.name === undefined ? {} : { name: o.name }),
          draft: o.draft,
        });
      } catch (err) {
        if (err instanceof BindingProposalError) {
          emitJson(program, fail(err.code, err.message));
          return;
        }
        emitJson(program, fail("E_INVALID_TAKE", err instanceof Error ? err.message : String(err)));
        return;
      }
      const { draft, ...rest } = proposal;
      let saved: ProposalDraftSummary | undefined;
      if (draft !== undefined) {
        try {
          saved = await saveDraft(draft, o.out, resolveJourneysDir(deps, o.journeysDir));
        } catch (err) {
          if (err instanceof DraftSaveError) {
            emitJson(program, fail(err.code, err.message));
            return;
          }
          throw err;
        }
      }
      const data: ProposalResult = { ...rest, ...(saved === undefined ? {} : { draft: saved }), nextSteps: nextSteps(proposal, saved) };
      if (o.json) {
        emitJson(program, ok(data));
        return;
      }
      program.configureOutput().writeOut?.(renderProposal(data));
      process.exitCode = 0;
    });
}

/** What `recording propose` reports about the draft it wrote (never its content — that is in the file). */
export interface ProposalDraftSummary {
  id: string;
  /** Where the draft was written: the journeys store, or `--out`. */
  path: string;
  savedTo: "journeys-store" | "file";
  promoted: false;
  steps: number;
}

export type ProposalResult = Omit<BindingProposal, "draft"> & { draft?: ProposalDraftSummary; nextSteps: string[] };

class DraftSaveError extends Error {
  constructor(
    readonly code: "E_PROPOSAL_DRAFT_EXISTS" | "E_PROPOSAL_INVALID_ID",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Writes the draft: to `--out`, or into the journeys store as an UNPROMOTED Journey (the same
 * `FsJourneyStore.put` every authoring path uses). Never overwrites an existing Journey — a draft must
 * never replace (or demote) a reviewed one — and never promotes or approves anything.
 */
async function saveDraft(draft: Journey, out: string | undefined, journeysDir: string): Promise<ProposalDraftSummary> {
  const steps = draft.recording.pages.reduce((n, p) => n + p.steps.length, 0);
  if (out !== undefined) {
    await writeFile(out, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    return { id: draft.metadata.id, path: resolvePath(out), savedTo: "file", promoted: false, steps };
  }
  const store = new FsJourneyStore(journeysDir);
  let existing: Journey | null;
  try {
    existing = await store.get(draft.metadata.id);
  } catch (err) {
    throw new DraftSaveError("E_PROPOSAL_INVALID_ID", err instanceof Error ? err.message : String(err));
  }
  if (existing !== null) {
    throw new DraftSaveError(
      "E_PROPOSAL_DRAFT_EXISTS",
      `a Journey '${draft.metadata.id}' already exists — a proposed draft never replaces one; pass --id <new-id>, or --out <file>`,
    );
  }
  await store.put(draft);
  const path = draft.metadata.id.includes("/")
    ? resolvePath(journeysDir, ...draft.metadata.id.split("/").slice(0, -1), `${draft.metadata.id.split("/").at(-1)}.json`)
    : resolvePath(journeysDir, `${draft.metadata.id}.json`);
  return { id: draft.metadata.id, path, savedTo: "journeys-store", promoted: false, steps };
}

function nextSteps(proposal: BindingProposal, saved: ProposalDraftSummary | undefined): string[] {
  if (saved === undefined) return ["re-run without --no-draft to save the draft Journey"];
  const id = saved.id;
  const params = proposal.params.map((p) => `--param ${p.name}=<${p.name}>`).join(" ");
  const steps: string[] = [];
  if (saved.savedTo === "file") steps.push(`copy ${saved.path} into the journeys directory (.jevitate/journeys/${id}.json) to review and verify it`);
  if (proposal.ambiguities.length > 0) steps.push(`decide each ambiguity (${proposal.ambiguities.length}) by editing the draft — none was resolved for you`);
  steps.push(`jevitate journey review ${id} --strict`);
  steps.push(`jevitate journey verify ${id} --mutate${params === "" ? "" : ` ${params}`}`);
  steps.push(`a person promotes it only when both are clean: jevitate journey promote ${id}`);
  return steps;
}

/** The human rendering of `recording propose` (stdout). Evidence is the proposal's redacted hints. */
function renderProposal(r: ProposalResult): string {
  const lines: string[] = [];
  lines.push(`Binding proposal from ${r.takes} takes (a draft for review — nothing is promoted or approved)`);
  lines.push("");
  if (r.ambiguities.length > 0) {
    lines.push(`!! AMBIGUITIES (${r.ambiguities.length}) — a person decides each; none was resolved for you:`);
    for (const a of r.ambiguities) lines.push(`   ! [${a.kind}] steps: ${a.stepIds.length === 0 ? "(none)" : a.stepIds.join(", ")} — ${a.message}`);
    lines.push("");
  }
  if (r.stopBefore === undefined) {
    lines.push("WARNING: no stop step (send/submit/post/publish) was found — the draft replays EVERY step, including any final submit. Mark where it must stop before running it.");
    lines.push("");
  } else {
    lines.push(`stop before: ${r.stopBefore} (the draft ends before this step${r.firstWriteStepId === undefined ? "" : `; first write: ${r.firstWriteStepId}`})`);
  }
  lines.push(`params (${r.params.length}):`);
  for (const p of r.params) lines.push(`  - ${p.name} (${p.kind}) ← ${p.stepIds.join(", ")}`);
  lines.push(`outputs (${r.outputs.length}):`);
  for (const out of r.outputs) lines.push(`  - ${out.key}${out.attr === undefined ? "" : ` [${out.attr}]`} from ${out.fromStepId}, tied to ${out.tiedTo}`);
  lines.push(`checks (${r.checks.length}):`);
  for (const c of r.checks) lines.push(`  - ${c.phase} ${c.reason} at ${c.stepId}: ${c.param}`);
  lines.push(`handbacks (${r.handbacks.length}):${r.handbacks.map((h) => ` ${h.stepId} (${h.reason})`).join(",")}`);
  lines.push(`constants: ${r.constants.length}`);
  lines.push("");
  if (r.draft !== undefined) {
    lines.push(
      r.draft.savedTo === "file"
        ? `draft Journey '${r.draft.id}' written to ${r.draft.path} (${r.draft.steps} steps, NOT promoted)`
        : `draft Journey '${r.draft.id}' saved to ${r.draft.path} (${r.draft.steps} steps, NOT promoted, no approval)`,
    );
  }
  lines.push("next:");
  for (const n of r.nextSteps) lines.push(`  ${n}`);
  return `${lines.join("\n")}\n`;
}

/** #566: a diff for the model — every captured value becomes a redacted hint (never the text). */
function redactDiffForModel(diff: ReturnType<typeof diffTakes>): unknown {
  return {
    ...diff,
    columns: diff.columns.map((c: ColumnClass) => ({ ...c, values: c.values.map((v) => (v === null ? null : valueHint(v))) })),
  };
}

/** #566: a post-documented Recording for the model — a constant's literal value becomes `{redacted, length}`. */
function redactRecordingForModel(rec: Recording): Recording {
  return {
    ...rec,
    pages: rec.pages.map((p) => ({
      ...p,
      steps: p.steps.map((r) => {
        const st = r.step;
        if ((st.kind === "fill" || st.kind === "select") && "redacted" in st.value && st.value.redacted === false) {
          return { ...r, step: { ...st, value: { redacted: true as const, length: st.value.value.length } } };
        }
        return r;
      }),
    })),
  };
}

/**
 * Distinguishes a malformed `--decisions <file>` (E_INVALID_DECISIONS) from
 * every other failure mode of the `postdoc` action (E_INVALID_TAKE) without
 * making `loadDecisions` itself responsible for emitting the CLI envelope —
 * matching this file's existing pattern of one try/catch per subcommand
 * mapping to one error code.
 */
class DecisionsParseError extends Error {
  constructor(public readonly cause: unknown) {
    super(String(cause));
  }
}

async function loadDecisions(file: string): Promise<PostdocDecision[]> {
  let raw: string;
  let parsed: unknown;
  try {
    raw = await readFile(file, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DecisionsParseError(err);
  }
  const result = PostdocDecisionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new DecisionsParseError(result.error);
  }
  return result.data;
}

/**
 * Thin `@clack/prompts` adapter: walks `authoring`'s fill/select steps in
 * order and asks the human how to classify each one. ALL logic (variance
 * guards, secret-materialization checks, the actual step rewrite) lives in
 * `applyPostdoc`/`diffTakes` — this function only collects a
 * `PostdocDecision[]` to hand them.
 */
async function promptForDecisions(authoring: AuthoringRecording): Promise<PostdocDecision[]> {
  clack.intro("recording postdoc — review captured fill/select steps");

  const decisions: PostdocDecision[] = [];
  const fillSteps = flattenBaseFillSteps(authoring.recording);

  for (const { ref } of fillSteps) {
    const classify = await clack.select({
      message: `Step ${ref.page}:${ref.step} — how should this value be classified?`,
      options: [
        { value: "constant" as const, label: "constant", hint: "fix this value in the artifact" },
        { value: "variable" as const, label: "variable", hint: "prompt for a value at replay time" },
        { value: "handback" as const, label: "handback", hint: "hand control to a human at replay time" },
      ],
    });
    if (clack.isCancel(classify)) {
      clack.cancel("postdoc review cancelled");
      process.exit(1);
    }

    const label = await promptOptionalText("Label for this step? (blank to skip)");
    const chunk = await promptOptionalText("Chunk name for this step? (blank to skip)");

    let decision: PostdocDecision;
    if (classify === "constant") {
      const acknowledgeVaried = await clack.confirm({
        message: "Acknowledge this value varied across takes anyway?",
        initialValue: false,
      });
      if (clack.isCancel(acknowledgeVaried)) {
        clack.cancel("postdoc review cancelled");
        process.exit(1);
      }
      decision = { step: ref, classify: "constant", ...(acknowledgeVaried ? { acknowledgeVaried: true as const } : {}) };
    } else if (classify === "variable") {
      const name = await clack.text({ message: "Variable name?" });
      if (clack.isCancel(name)) {
        clack.cancel("postdoc review cancelled");
        process.exit(1);
      }
      decision = { step: ref, classify: "variable", name };
    } else {
      const prompt = await clack.text({ message: "Handback prompt for the human operator?" });
      if (clack.isCancel(prompt)) {
        clack.cancel("postdoc review cancelled");
        process.exit(1);
      }
      decision = { step: ref, classify: "handback", prompt };
    }

    if (label !== undefined) decision = { ...decision, label };
    if (chunk !== undefined) decision = { ...decision, chunk };
    decisions.push(decision);
  }

  clack.outro("review complete");
  return decisions;
}

async function promptOptionalText(message: string): Promise<string | undefined> {
  const value = await clack.text({ message, defaultValue: "" });
  if (clack.isCancel(value)) {
    clack.cancel("postdoc review cancelled");
    process.exit(1);
  }
  return value === "" ? undefined : value;
}
