/**
 * #453 change-aware self-heal: turn a git diff and/or human change notes into `ChangeEvidence`.
 * Pure: no fs, no child_process, no clock, no network. Raw diff hunks never leave this module.
 */

import type { ChangeEvidence, ChangeEvidenceKind } from "./change-scope.js";

const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock"]);
const SECRET_EXTENSION = /\.(pem|key|p12|pfx)$/i;

/** True when a changed path is a secret, lockfile or other file whose contents must not be surfaced. */
export function isSkippedChangePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (SECRET_EXTENSION.test(base)) return true;
  if (LOCKFILES.has(base)) return true;
  return normalized
    .toLowerCase()
    .split("/")
    .some((segment) => segment.includes("secret"));
}

interface Fact {
  readonly kind: ChangeEvidenceKind;
  readonly before: string;
  readonly after: string;
}

type Emit = (evidence: Omit<ChangeEvidence, "id">) => void;

/** Extract ordered UI evidence from a `git diff --no-color -M --unified=0` plus human notes. */
export function extractChangeEvidence(diff: string, notes: readonly string[]): ChangeEvidence[] {
  const evidence: ChangeEvidence[] = [];
  const emit: Emit = (item) => {
    evidence.push({ id: `e${evidence.length + 1}`, ...item });
  };

  const lines = diff.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[index]);
    if (!header) {
      index++;
      continue;
    }
    const oldPath = unquote(header[1]);
    const newPath = unquote(header[2]);
    const section: string[] = [];
    index++;
    while (index < lines.length && !lines[index].startsWith("diff --git ")) {
      section.push(lines[index]);
      index++;
    }
    if (section.some((line) => line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))) continue;
    if (isSkippedChangePath(oldPath) || isSkippedChangePath(newPath)) continue;
    processSection(oldPath, newPath, section, emit);
  }

  for (const note of notes) {
    const pair = parseNotePair(note);
    if (pair) {
      emit({ kind: "note", note, before: pair[0], after: pair[1] });
    } else {
      emit({ kind: "note", note });
    }
  }

  return evidence;
}

function processSection(oldPath: string, newPath: string, section: readonly string[], emit: Emit): void {
  const renameFrom = /^rename from (.*)$/.exec(section.find((line) => line.startsWith("rename from ")) ?? "");
  const renameTo = /^rename to (.*)$/.exec(section.find((line) => line.startsWith("rename to ")) ?? "");
  if (renameFrom && renameTo && (isRoutePath(oldPath) || isRoutePath(newPath))) {
    emit({ kind: "route", before: unquote(renameFrom[1]), after: unquote(renameTo[1]), file: newPath });
  }

  const i18n = isI18nJson(newPath);
  let cursor = 0;
  while (cursor < section.length) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(section[cursor]);
    if (!hunk) {
      cursor++;
      continue;
    }
    const headerLine = section[cursor];
    cursor++;
    const body: string[] = [];
    while (cursor < section.length && !section[cursor].startsWith("@@ ")) {
      body.push(section[cursor]);
      cursor++;
    }
    processHunk(body, Number(hunk[1]), Number(hunk[2]), headerLine, newPath, i18n, emit);
  }
}

function processHunk(body: readonly string[], oldStart: number, newStart: number, header: string, file: string, i18n: boolean, emit: Emit): void {
  let oldLine = oldStart;
  let newLine = newStart;
  const removals: { text: string; line: number }[] = [];
  const additions: { text: string; line: number }[] = [];

  for (const line of body) {
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) {
      removals.push({ text: line.slice(1), line: oldLine });
      oldLine++;
    } else if (line.startsWith("+")) {
      additions.push({ text: line.slice(1), line: newLine });
      newLine++;
    } else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }

  const paired = Math.min(removals.length, additions.length);
  for (let i = 0; i < paired; i++) {
    const fact = detectFact(removals[i].text, additions[i].text, i18n);
    if (fact) {
      emit({ kind: fact.kind, before: fact.before, after: fact.after, file, line: additions[i].line, hunk: header });
    }
  }

  for (let i = paired; i < additions.length; i++) {
    if (isInsertedUi(additions[i].text)) {
      emit({ kind: "inserted-ui", after: additions[i].text.trim(), file, line: additions[i].line, hunk: header });
    }
  }
}

function detectFact(before: string, after: string, i18n: boolean): Fact | undefined {
  const testId = attributeChange(before, after, ["data-testid", "data-test", "data-cy"]);
  if (testId) return { kind: "test-id", ...testId };

  const accessibleName = attributeChange(before, after, ["aria-labelledby"]);
  if (accessibleName) return { kind: "accessible-name", ...accessibleName };

  const label = attributeChange(before, after, ["aria-label", "title", "alt", "placeholder"]) ?? propChange(before, after, "label");
  if (label) return { kind: "label", ...label };

  const route = attributeChange(before, after, ["path"]);
  if (route) return { kind: "route", ...route };

  const redirect = redirectChange(before, after);
  if (redirect) return { kind: "redirect", ...redirect };

  if (i18n) {
    const copy = jsonValueChange(before, after);
    if (copy) return { kind: "copy", ...copy };
  }

  const text = textContentChange(before, after);
  if (text) return { kind: "copy", ...text };

  return undefined;
}

function attributeChange(before: string, after: string, names: readonly string[]): { before: string; after: string } | undefined {
  for (const name of names) {
    const b = attributeValue(before, name);
    const a = attributeValue(after, name);
    if (b !== undefined && a !== undefined && b !== a) return { before: b, after: a };
  }
  return undefined;
}

function attributeValue(text: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*[:=]\\s*["']([^"']*)["']`).exec(text);
  return match ? match[1].trim() : undefined;
}

function propChange(before: string, after: string, name: string): { before: string; after: string } | undefined {
  const b = propValue(before, name);
  const a = propValue(after, name);
  if (b !== undefined && a !== undefined && b !== a) return { before: b, after: a };
  return undefined;
}

function propValue(text: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s,{])${name}\\s*[:=]\\s*["']([^"']*)["']`).exec(text);
  return match ? match[1].trim() : undefined;
}

function redirectChange(before: string, after: string): { before: string; after: string } | undefined {
  const b = redirectValue(before);
  const a = redirectValue(after);
  if (b !== undefined && a !== undefined && b !== a) return { before: b, after: a };
  return undefined;
}

function redirectValue(text: string): string | undefined {
  const call = /redirect\(\s*["']([^"']*)["']/.exec(text);
  if (call) return call[1].trim();
  const location = /\bLocation:\s*(\S+)/.exec(text);
  return location ? location[1].trim() : undefined;
}

function jsonValueChange(before: string, after: string): { before: string; after: string } | undefined {
  const b = jsonEntry(before);
  const a = jsonEntry(after);
  if (b && a && b.key === a.key && b.value !== a.value) return { before: b.value, after: a.value };
  return undefined;
}

function jsonEntry(text: string): { key: string; value: string } | undefined {
  const match = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(text);
  return match ? { key: match[1], value: match[2].trim() } : undefined;
}

function textContentChange(before: string, after: string): { before: string; after: string } | undefined {
  const b = textContent(before);
  const a = textContent(after);
  if (b !== undefined && a !== undefined && b !== a) return { before: b, after: a };
  return undefined;
}

function textContent(text: string): string | undefined {
  const match = />([^<>]+)</.exec(text);
  return match ? match[1].trim() : undefined;
}

function isInsertedUi(text: string): boolean {
  return /role\s*=\s*["']dialog["']/.test(text) || text.includes("<dialog") || text.includes("confirm(");
}

function isI18nJson(path: string): boolean {
  if (!/\.json$/i.test(path)) return false;
  return path
    .toLowerCase()
    .split("/")
    .some((segment) => segment.includes("locale") || segment.includes("i18n") || segment.includes("lang"));
}

function isRoutePath(path: string): boolean {
  return /^(app|pages|routes)\//.test(path);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function parseNotePair(note: string): [string, string] | undefined {
  const quoted = /["']([^"']+)["']\s*->\s*["']([^"']+)["']/.exec(note);
  if (quoted) return [quoted[1].trim(), quoted[2].trim()];

  const renamed = /renamed\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+to\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(note);
  if (renamed) {
    const before = renamed[1] ?? renamed[2] ?? renamed[3];
    const after = renamed[4] ?? renamed[5] ?? renamed[6];
    if (before !== undefined && after !== undefined) return [before.trim(), after.trim()];
  }

  const arrow = /(\S+)\s*->\s*(\S+)/.exec(note);
  if (arrow) return [arrow[1].trim(), arrow[2].trim()];
  return undefined;
}
