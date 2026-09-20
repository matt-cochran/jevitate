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

const here = dirname(fileURLToPath(import.meta.url));

const EXTERNAL = [
  "playwright",
  "better-sqlite3",
  "commander",
  "@clack/prompts",
  "ai",
  "@openrouter/ai-sdk-provider",
  "@typesafe-ai/sdk",
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
