import { Command } from "commander";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { describeProvenance } from "../approval-provenance.js";
import { type CliDeps, resolveJourneysDir, emitJson } from "../cli-shared.js";

/** Registers `jevitate journey list`. */
export function registerJourneyList(journey: Command, program: Command, deps: CliDeps): void {
  /**
   * `journey list` = ALL journeys' metadata via the store directly
   * (promoted AND unpromoted) — a local/dev-facing listing of everything on
   * disk. `journey find` (below) = promoted-only, via `JourneyRegistry.find`
   * — the same promoted-only projection external callers (e.g. the
   * mcp-facade) see. Keeping these distinct means `list` is useful for
   * authoring/debugging while `find` genuinely reflects what's discoverable.
   */
  journey
    .command("list")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const store = new FsJourneyStore(resolveJourneysDir(deps, dir));
        const metas = await store.list();
        const envelope = ok(metas);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          if (metas.length === 0) {
            out?.("no journeys yet — record one with `jevitate record` (see jevitate record --help)\n");
          } else {
            for (const m of metas) {
              // #437: how a promoted Journey's approval was made ("approved non-interactively (likely an agent: CLAUDECODE)").
              const how = m.promoted && m.approval !== undefined ? ` — ${describeProvenance(m.approval.provenance)}` : "";
              out?.(`${m.id}\t${m.name}${m.promoted ? "" : " (unpromoted)"}${how}\n`);
            }
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_LIST", String(err)));
      }
    });
}
