import { Command } from "commander";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import { ok, fail } from "./envelope.js";
import { runRecording, resolveRecordAllowlist } from "./record-api.js";
import { type CliDeps, emitJson, extensionArg } from "./cli-shared.js";
import { allowWithExtensions, assertExtensionTargetLoaded } from "./browser-run-options.js";
import type { UnpackedExtension } from "@jevitate/playwright";

/** Registers `jevitate record` (record-by-demonstration). */
export function registerRecordCommands(program: Command, deps: CliDeps): void {
  // Additive: `jevitate record` — record-by-demonstration (Ticket #22). Opens a
  // real browser on an authorized origin, lets the user demonstrate a flow, and
  // captures it into a schema-valid, replayable Recording written to disk. The
  // authorized-origin guard is enforced FIRST (fail-closed) inside runRecording,
  // before any browser is opened; the temp profile dir is always cleaned up.
  program
    .command("record")
    .description("record a demonstrated flow into a Recording (authoring plane)")
    .option("--url <url>", "start URL to demonstrate from (must be an authorized origin)")
    .option("--intent <text>", "your framing of the journey (carried to Recording.intent)")
    .option("--retro <text>", "optional retrospective note (carried to Recording.retro)")
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--extension <dir>",
      "load this unpacked browser extension (repeatable; a directory with manifest.json); its chrome-extension://<id> origin is allowed",
      extensionArg,
      [] as UnpackedExtension[],
    )
    .option("--headless", "run headless (default: headed — a record session is a live demonstration)", false)
    .option("--out <dir>", "directory to write the emitted Recording (default: .jevitate/logs/<date> in the project, else ~/.jevitate/logs/<date>)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<{
        url?: string;
        intent?: string;
        retro?: string;
        allow: string[];
        headless?: boolean;
        extension: UnpackedExtension[];
        out?: string;
        json?: boolean;
      }>();

      if (!o.url) {
        emitJson(program, fail("E_RECORD_ARGS", "--url is required"));
        return;
      }
      const browser = o.extension.length === 0 ? undefined : { extensions: o.extension };
      try {
        assertExtensionTargetLoaded(o.url, browser);
      } catch (err) {
        emitJson(program, fail("E_RECORD_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #256: a loaded extension's chrome-extension://<id> origin is allowed too (only those ids).
      const allowlist = allowWithExtensions(o.url, resolveRecordAllowlist(o.url, o.allow), browser);

      try {
        const result = await runRecording({
          url: o.url,
          allowlist,
          intent: o.intent,
          retro: o.retro,
          outDir: o.out,
          headless: o.headless ?? false,
          ...(browser === undefined ? {} : { extensions: browser.extensions }),
          browserPortFactory: deps.record?.browserPortFactory,
          recorderFactory: deps.record?.recorderFactory,
          waitForStop: deps.record?.waitForStop,
        });
        const summary = {
          recordingPath: result.recordingPath,
          steps: result.steps,
          pages: result.pages,
          finalUrl: result.finalUrl,
        };
        if (o.json) {
          emitJson(program, ok(summary));
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(summary)}\n`);
        }
      } catch (err) {
        if (err instanceof UnauthorizedExploreTargetError) {
          emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else {
          emitJson(program, fail("E_RECORD_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
