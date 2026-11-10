import { Command } from "commander";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { type CliDeps, emitJson } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { loadCatalog, resolveCatalogDir } from "../catalog-api.js";
import { capabilityParameters } from "../journey-find-api.js";
import { linkedJobDone } from "../catalog-refs.js";
import { DEPRECATED_DIR_HELP, flaggedCatalogDir, journeyLayout } from "./shared.js";

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
        // #800: like MCP find_capabilities, a capability that links a catalog job carries
        // `job: { id, status, done?: { at, check } }` (best effort: no catalog leaves it out).
        let catalog: Awaited<ReturnType<typeof loadCatalog>> | undefined;
        try {
          catalog = await loadCatalog(resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout)), layout.journeysDir);
        } catch {
          catalog = undefined;
        }
        const capabilities = await Promise.all(
          metas.map(async (m) => {
            const journey = await store.get(m.id);
            const job = catalog === undefined || journey === null ? undefined : linkedJobDone(catalog, journey);
            const parameters = capabilityParameters(journey);
            return { id: m.id, name: m.name, description: m.description, params: m.params, ...(parameters === undefined ? {} : { parameters }), ...(job === undefined ? {} : { job }) };
          }),
        );
        const envelope = ok(capabilities);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const c of capabilities) {
            const done = c.job === undefined ? "" : c.job.done === undefined ? `\tjob=${c.job.id} done=none` : `\tjob=${c.job.id} done=${c.job.done.at} ${c.job.done.check}`;
            const types = c.parameters === undefined ? "" : `\ttypes=[${c.parameters.map((p) => (p.type === undefined ? p.name : p.type === "enum" ? `${p.name}:enum(${(p.enum ?? []).join("|")})` : `${p.name}:${p.type}`)).join(", ")}]`;
            out?.(`${c.id}\t${c.name}\tparams=[${c.params.join(", ")}]${types}${done}\n`);
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_FIND", String(err)));
      }
    });
}
