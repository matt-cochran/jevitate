// === Patterns and globs ===

/** `"/re/flags"` → a RegExp; anything else → null (a literal). Throws on an invalid regex. */
export function patternRegex(src: string): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(src);
  if (m === null) return null;
  return new RegExp(m[1] as string, m[2]);
}

/** Does `text` match a pattern: a `/regex/` searches, a literal must equal (`exact`) or be contained. */
export function matchesPattern(pattern: string, text: string, exact: boolean): boolean {
  const re = patternRegex(pattern);
  if (re !== null) {
    re.lastIndex = 0;
    return re.test(text);
  }
  return exact ? text.trim() === pattern.trim() : text.includes(pattern);
}

/** A URL/path glob → RegExp: `**` any run, `*` any run without `/`, everything else literal. */
export function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else out += "[^/]*";
    } else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
