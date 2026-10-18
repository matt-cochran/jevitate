import { Command } from "commander";
import { resolveCatalogDir } from "./catalog-api.js";
import { emitCommandResult, type CliDeps } from "./cli-shared.js";
import { fail, ok } from "./envelope.js";
import { EXIT_CODES } from "./exit-codes.js";
import { journeyLayout, targetsOpts } from "./journey-cli/shared.js";
import { BundleStaleError, buildJourneyBundle, checkJourneyBundle } from "./journey-bundle.js";
import { withProjectFlags } from "./project-layout.js";

/**
 * #584 — `jevitate journey bundle <id> [--with <toId>] --out <dir>` and
 * `jevitate journey bundle --check <dir>` (docs/contracts/readiness-and-bundle.md §4). A local,
 * never-uploaded review bundle; `--check` re-derives every hash and exits 1 with `E_BUNDLE_STALE`
 * naming what changed. Only prints human-only commands — it never approves, promotes or sends.
 */

/** The build's exit code follows the readiness verdict (§3): ready 0, blocked 1, otherwise 2. */
function verdictExitCode(verdict: "technically-ready" | "blocked" | "inconclusive" | "incomplete"): number {
  if (verdict === "technically-ready") return EXIT_CODES.ok;
  if (verdict === "blocked") return EXIT_CODES.defects;
  return EXIT_CODES.inconclusive;
}

/** Registers `jevitate journey bundle` (not wired into `journey-cli.ts` by this deliverable). */
export function registerJourneyBundle(journey: Command, program: Command, deps: CliDeps): void {
  withProjectFlags(journey.command("bundle [id]"))
    .description("write a local review bundle (bundle.md + manifest.json) for a Journey (or a linked pair), or check one with --check <dir>")
    .option("--with <toId>", "a linked pair: <id> produces, <toId> consumes")
    .option("--out <dir>", "the directory to write bundle.md and manifest.json into (required unless --check)")
    .option("--check <dir>", "re-derive a bundle's hashes and fail closed with E_BUNDLE_STALE when any moved")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id?: string) {
      const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
      const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
      if (layout === null) return;
      const { with: withId, out, check, json } = this.opts<{ with?: string; out?: string; check?: string; json?: boolean }>();
      const catalogDir = resolveCatalogDir(deps.catalogDir, layout.catalogDir ?? undefined);
      const location = { journeysDir: layout.journeysDir, catalogDir, ...targetsOpts(deps) };
      const bundleDeps = { cwd: () => process.cwd() };

      if (check !== undefined) {
        try {
          const result = await checkJourneyBundle(check, location, bundleDeps);
          emitCommandResult(program, ok(result), { json: json === true, command: "journey bundle", human: () => `bundle is current: ${check}\n` });
        } catch (err) {
          if (err instanceof BundleStaleError) {
            emitCommandResult(program, fail(err.code, err.message), { json: json === true, exitCode: EXIT_CODES.defects, command: "journey bundle" });
            return;
          }
          emitCommandResult(program, fail("E_BUNDLE", err instanceof Error ? err.message : String(err)), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey bundle" });
        }
        return;
      }

      if (id === undefined || out === undefined) {
        emitCommandResult(program, fail("E_BUNDLE_ARGS", "--out <dir> is required (or pass --check <dir> to check an existing bundle)"), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey bundle" });
        return;
      }
      try {
        const result = await buildJourneyBundle({ id, ...(withId === undefined ? {} : { with: withId }), out, ...location }, bundleDeps);
        emitCommandResult(program, ok(result), { json: json === true, exitCode: verdictExitCode(result.verdict), command: "journey bundle", human: (r) => `${r.verdict} — wrote ${r.files.join(", ")}\n` });
      } catch (err) {
        if (err instanceof BundleStaleError) {
          emitCommandResult(program, fail(err.code, err.message), { json: json === true, exitCode: EXIT_CODES.defects, command: "journey bundle" });
          return;
        }
        emitCommandResult(program, fail("E_BUNDLE", err instanceof Error ? err.message : String(err)), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey bundle" });
      }
    });
}
