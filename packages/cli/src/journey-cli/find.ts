import { Command } from "commander";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { type CliDeps, emitJson } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP, journeyLayout } from "./shared.js";

/** Registers `jevitate journey find`. */
export function registerJourneyFind(journey: Command, program: Command, deps: CliDeps): void {
  // RULING 5: uses `JourneyRegistry.find` (from `@jevitate/journey`) directly —
  // NEVER `@jevitate/mcp-facade`'s `findCapabilities` — Slice 1 forbids the CLI
  // depending on `@jevitate/mcp-facade`. `JourneyRegistry.find` is already
  // promoted-only, so this is the same promoted-only view without the
  // forbidden dependency.
  withProjectFlags(journey
    .command("find <query>")
    .option("--dir <path>", DEPRECATED_DIR_HELP))
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, query: string) {
      const { dir, project, journeysDir, json } = this.opts<{ dir?: string; project?: string; journeysDir?: string; json?: boolean }>();
      const layout = journeyLayout(program, deps, { dir, project, journeysDir });
      if (layout === null) return;
      try {
        const store = new FsJourneyStore(layout.journeysDir);
        const registry = new JourneyRegistry(store);
        const metas = await registry.find(query);
        const capabilities = metas.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          params: m.params,
        }));
        const envelope = ok(capabilities);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const c of capabilities) {
            out?.(`${c.id}\t${c.name}\tparams=[${c.params.join(", ")}]\n`);
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_FIND", String(err)));
      }
    });
}
