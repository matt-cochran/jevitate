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
