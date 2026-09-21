#!/usr/bin/env node
// Slice 1 exit-gate: fail-fast if the source tree contains a "permissive
// fallback" around a safety decision — an error/absence being silently
// turned into a fake success. This is a HARD gate (see task-11-brief.md):
// a real hit is a failure to RESOLVE, never to suppress.
//
// Anti-patterns detected (heuristic, textual — no new dependency):
//   1. A `catch` block whose body `return`s an `{ outcome: "ok", ... }`
//      success — swallowing an error into a fake success.
//   2. A policy/secret/outcome-shaped expression defaulted to success via
//      `?? { outcome: "ok" }` / `|| { outcome: "ok" }` / `?? "ok"`.
//   3. `run_journey`/`runJourney` accepting an inline `steps`/`recording`
//      argument (invariant #5 — published-id-only, no inline steps).
//
// Usage: node scripts/check-no-permissive-fallback.mjs [rootDir]
//   rootDir defaults to <repoRoot>/packages (matching packages/*/src/**/*.ts).
//   Can also be set via the CHECK_FALLBACK_ROOT env var (the CLI arg wins).

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(scriptDir, "..");

const customRoot = process.argv[2] || process.env.CHECK_FALLBACK_ROOT;
const root = customRoot ? customRoot : join(repoRoot, "packages");

/** Recursively collects candidate .ts source files, skipping node_modules/dist
 * and test files, and requiring a `src` path segment (mirrors the intended
 * `packages/*\/src/**\/*.ts` glob without pulling in a glob dependency). */
function collectSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      extname(entry) === ".ts" &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts") &&
      full.split(sep).includes("src")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Given text and the index of an opening `{`, returns the index just past
 * the matching closing `}` (brace-depth aware, ignores braces inside string
 * literals well enough for TypeScript source in practice). */
function findMatchingBraceEnd(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

const CATCH_RE = /\bcatch\b\s*(\([^)]*\))?\s*\{/g;
const RETURN_OK_RE = /return\s*\{[\s\S]{0,200}?\boutcome\s*:\s*["']ok["']/;

const PERMISSIVE_DEFAULT_RE =
  /\b(policy|secret\w*|outcome)\b[^\n;]{0,80}(\?\?|\|\|)\s*(\{[^{}\n]{0,80}\boutcome\s*:\s*["']ok["'][^{}\n]{0,80}\}|["']ok["'])/gi;

const INLINE_STEPS_RE =
  /\b(run_journey|runJourney)\b[\s\S]{0,200}?\b(steps|recording)\s*:/g;

/** Returns the 1-based line number for a given character offset. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function scanFile(file) {
  const text = readFileSync(file, "utf8");
  const hits = [];

  // 1. catch { ... return { outcome: "ok" ... } ... }
  let m;
  CATCH_RE.lastIndex = 0;
  while ((m = CATCH_RE.exec(text))) {
    const braceOpen = text.indexOf("{", m.index + m[0].length - 1);
    if (braceOpen === -1) continue;
    const braceEnd = findMatchingBraceEnd(text, braceOpen);
    const block = text.slice(braceOpen, braceEnd);
    const found = RETURN_OK_RE.exec(block);
    if (found) {
      hits.push({
        line: lineAt(text, braceOpen + found.index),
        reason: 'catch block returns a fake success ({ outcome: "ok" }) instead of propagating/handling the error',
      });
    }
  }

  // 2. policy/secret/outcome defaulted to success via ?? / ||
  PERMISSIVE_DEFAULT_RE.lastIndex = 0;
  while ((m = PERMISSIVE_DEFAULT_RE.exec(text))) {
    hits.push({
      line: lineAt(text, m.index),
      reason: `permissive default to success: "${m[0].trim()}"`,
    });
  }

  // 3. run_journey/runJourney accepting inline steps/recording
  INLINE_STEPS_RE.lastIndex = 0;
  while ((m = INLINE_STEPS_RE.exec(text))) {
    hits.push({
      line: lineAt(text, m.index),
      reason: `${m[1]} appears to accept an inline "${m[2]}" argument (invariant #5 requires published-id-only)`,
    });
  }

  return hits;
}

function main() {
  const files = collectSourceFiles(root);
  const allHits = [];
  for (const file of files) {
    const hits = scanFile(file);
    for (const hit of hits) {
      allHits.push({ file, ...hit });
    }
  }

  if (allHits.length > 0) {
    console.error("Permissive-fallback exit-gate FAILED — forbidden shapes found:\n");
    for (const hit of allHits) {
      console.error(`${hit.file}:${hit.line} — ${hit.reason}`);
    }
    console.error(`\n${allHits.length} hit(s). Resolve these — do not suppress the gate.`);
    process.exit(1);
  }

  console.log(`check-no-permissive-fallback: OK (${files.length} file(s) scanned, 0 hits)`);
  process.exit(0);
}

main();
