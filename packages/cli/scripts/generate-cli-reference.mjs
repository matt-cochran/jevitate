// Writes docs/cli.md from the built CLI (run `pnpm -r build` first). Invoked via `pnpm docs:cli`.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "../dist/program.js";
import { renderCliReference } from "../dist/cli-reference.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cli.md");
writeFileSync(out, renderCliReference(buildProgram({ profiles: new ProfileManager("/unused-in-cli-reference") })));
console.log("wrote docs/cli.md");
