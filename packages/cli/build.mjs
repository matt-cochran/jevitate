#!/usr/bin/env node
// Bundles the `jevitate` CLI binary into a single ESM file for npm publish.
//
// Everything internal — all `@jevitate/*` workspace packages plus pure-JS
// deps (zod, nanoid, luxon, kysely, ...) — gets compiled INTO dist/bin.js.
// Native/heavy deps that can't (or shouldn't) be bundled stay external and
// are declared as real "dependencies" in package.json so npm installs them
// alongside the published package; at runtime they resolve normally from
// node_modules.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, rmSync } from "node:fs";
import { writeBuildInfoModule } from "./scripts/generate-build-info.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Build identity (issue #83): the commit/build-time this bundle was made from, injected as
// literals via esbuild `define` — never fabricated, `"unknown"` when `git rev-parse` fails
// (see generate-build-info.mjs). Also (re)writes `src/build-info.generated.ts`, the fallback
// `./engine.ts` reads when `__JEVITATE_*__` isn't defined (the plain `tsc --build` dist that
// `npm link` runs never goes through esbuild, so it never gets this `define` substitution).
const { commit, builtAt } = writeBuildInfoModule();

const EXTERNAL = [
  "playwright",
  "better-sqlite3",
  "commander",
  "@clack/prompts",
  "ai",
  "@openrouter/ai-sdk-provider",
  "@typesafe-ai/sdk",
  // MCP server SDK for `jevitate mcp` — a runtime external (declared in
  // package.json "dependencies"), kept out of the bundle like the natives
  // above so npm installs it alongside the published CLI.
  "@modelcontextprotocol/sdk",
];

await build({
  entryPoints: [join(here, "src", "bin.ts")],
  outfile: join(here, "dist", "bin.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: EXTERNAL,
  logLevel: "info",
  define: {
    __JEVITATE_BUILD_COMMIT__: JSON.stringify(commit),
    __JEVITATE_BUILT_AT__: JSON.stringify(builtAt),
  },
});

// `@jevitate/skills` is `private: true` and cannot be published as an external
// npm dependency, so its SKILL.md content is bundled WITH the CLI: its loader
// code is inlined into dist/bin.js by esbuild above, and its markdown data is
// copied here to `packages/cli/skills` — which is exactly where the inlined
// `loadManifest()` resolves its default dir to at runtime (`import.meta.url`
// of dist/bin.js → `../skills`). This dir is generated + gitignored; it ships
// via package.json "files".
const skillsSrc = join(here, "..", "skills", "skills");
const skillsDest = join(here, "skills");
rmSync(skillsDest, { recursive: true, force: true });
cpSync(skillsSrc, skillsDest, { recursive: true });
console.log(`copied skill set -> ${skillsDest}`);
