export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Parses a Claude-Code-style `SKILL.md`: a `---`-fenced frontmatter block with
 * two flat string fields (`name`, `description`) followed by a Markdown body.
 *
 * Deliberately NOT a YAML parser — only two flat string fields are ever needed
 * here, so a full YAML dependency would be over-engineering. Each frontmatter
 * line is split on its FIRST `:` only (so a `description` value may itself
 * contain colons). Fail-closed: a malformed block (missing closing fence, or a
 * missing required field) throws rather than silently treating the whole file
 * as body — a broken skill file must be loud, never quietly wrong.
 */
export function parseFrontmatter(md: string): ParsedSkill {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error("frontmatter must start with a '---' fence on the first line");
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error("frontmatter is missing its closing '---' fence");
  }

  const fields: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length > 0) fields[key] = value;
  }

  const name = fields.name;
  if (!name) throw new Error("frontmatter is missing a 'name' field");
  const description = fields.description;
  if (!description) throw new Error("frontmatter is missing a 'description' field");

  // Body is everything after the closing fence, with a single leading blank
  // line trimmed (the conventional blank line between frontmatter and body).
  let bodyStart = closeIdx + 1;
  if (lines[bodyStart] !== undefined && lines[bodyStart].trim() === "") {
    bodyStart += 1;
  }
  const body = lines.slice(bodyStart).join("\n");

  return { name, description, body };
}
