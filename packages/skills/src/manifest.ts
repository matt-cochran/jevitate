import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";

export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
  body: string;
}

/**
 * Resolves relative to THIS module's own location, so it works both from `src`
 * (vitest / ts) and from `dist` after build: `dist/manifest.js` → `dist/../skills`
 * = the package root's `skills/` dir, which `package.json`'s `"files"` ships as
 * a sibling of `dist`.
 */
const DEFAULT_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/**
 * Scans every subdirectory of `skillsDir` for a `SKILL.md`, parses its
 * frontmatter, and returns the manifest as a live projection of the files —
 * there is structurally no hand-maintained list to drift out of sync. A
 * malformed `SKILL.md` throws (fail-closed, naming the path) rather than being
 * silently dropped from the installed set.
 */
export function loadManifest(skillsDir: string = DEFAULT_SKILLS_DIR): ResolvedSkill[] {
  const ids = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return ids.map((id) => {
    const filePath = join(skillsDir, id, "SKILL.md");
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`invalid SKILL.md at ${filePath}: ${err instanceof Error ? err.message : err}`);
    }
    return { id, name: parsed.name, description: parsed.description, filePath, body: parsed.body };
  });
}
