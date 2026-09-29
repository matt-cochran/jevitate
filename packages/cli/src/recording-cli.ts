import { readFile, writeFile } from "node:fs/promises";
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
import { ok, fail } from "./envelope.js";
import { nonNegativeIntArg } from "./cli-args.js";
import { type CliDeps, emitJson } from "./cli-shared.js";

/** Registers `jevitate recording`: `promote|diff|fit|postdoc`. */
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
  async function readAuthoringTake(file: string): Promise<AuthoringRecording> {
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
          `'recording diff'/'recording postdoc' need a take file written by 'jevitate record' — shape ` +
          `{ recording, values } — not a raw Recording from 'explore', 'explore-author-journey', or a ` +
          `usability run. Wrap it as { "recording": <the Recording>, "values": {} } if you want to ` +
          `diff/postdoc it anyway.`,
      );
    }
    const parsed = AuthoringTakeSchema.parse(json);
    return { recording: parsed.recording, values: new Map(Object.entries(parsed.values)) };
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
        const raw = await readFile(file, "utf8");
        const rec: Recording = RecordingSchema.parse(JSON.parse(raw));
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
        const envelope = ok(diffResult);
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
        const raw = await readFile(file, "utf8");
        const rec: Recording = RecordingSchema.parse(JSON.parse(raw));
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
          emitJson(program, ok(result));
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
