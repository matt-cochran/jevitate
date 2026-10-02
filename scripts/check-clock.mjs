#!/usr/bin/env node
// #304 guard (part of `pnpm lint`): Node-side source reads time and schedules timers ONLY through the
// injectable clock (`clock` from @jevitate/domain, packages/domain/src/clock.ts), so tests can drive
// time with a FakeClock instead of waiting on the wall clock.
//
// Flags, in every package's non-test source (the files its tsconfig compiles):
//   Date.now()   new Date() (no arguments)   performance.now()   (and Date.now / performance.now as values)
//   setTimeout / clearTimeout / setInterval / clearInterval used as the global
//   `setTimeout` imported from node:timers/promises
//
// Allowed (never flagged):
//   - packages/domain/src/clock.ts itself;
//   - BROWSER code, which keeps the page's native timers (page time is Playwright's `page.clock`):
//     a function passed inline to `evaluate*` / `$eval` / `$$eval` / `addInitScript` /
//     `waitForFunction`; a same-file function passed to one of those by name or serialized with
//     `fn.toString()`; a declaration whose doc comment says `BROWSER CODE`; a file with the marker
//     `@jevitate-browser-code` or a header saying "THIS FILE IS BROWSER CODE"; string scripts;
//   - a line carrying `// clock-ok: <reason>` (or the line after such a comment).
//
// Usage: node scripts/check-clock.mjs [file...]   (no args: every package's source)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLOCK_MODULE = join(REPO, "packages/domain/src/clock.ts");
const BROWSER_CALLEES = new Set(["evaluate", "evaluateHandle", "evaluateAll", "$eval", "$$eval", "addInitScript", "waitForFunction"]);
const TIMERS = new Set(["setTimeout", "clearTimeout", "setInterval", "clearInterval"]);

function sourceFiles() {
  const out = [];
  const root = join(REPO, "packages");
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    const tsconfig = join(dir, "tsconfig.json");
    if (!existsSync(tsconfig) || !existsSync(join(dir, "src"))) continue;
    const cfg = ts.readConfigFile(tsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir);
    for (const f of parsed.fileNames) {
      if (f.endsWith(".ts") && !f.endsWith(".d.ts") && !/\.test\.ts$/.test(f) && f.startsWith(join(dir, "src"))) out.push(f);
    }
  }
  return out;
}

/** Violations in one file's text: [{ line, text }]. Exported shape for the guard's own test. */
export function checkSource(fileName, text) {
  if (resolve(fileName) === CLOCK_MODULE) return [];
  if (text.includes("@jevitate-browser-code") || /FILE IS BROWSER CODE/.test(text.slice(0, 2_000))) return [];
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const lines = text.split("\n");
  const browser = [];
  const browserNames = new Set();
  const local = new Set(); // names bound locally (a parameter / variable / import called setTimeout, say)

  const docSaysBrowser = (node) => {
    let target = node;
    if (ts.isVariableDeclaration(node) && node.parent?.parent && ts.isVariableStatement(node.parent.parent)) target = node.parent.parent;
    return (ts.getLeadingCommentRanges(text, target.getFullStart()) ?? []).some((r) => /BROWSER CODE/.test(text.slice(r.pos, r.end)));
  };
  const collect = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (BROWSER_CALLEES.has(name)) {
        for (const a of node.arguments) {
          if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) browser.push([a.getStart(sf), a.getEnd()]);
          else if (ts.isIdentifier(a)) browserNames.add(a.text);
        }
      }
      if (name === "toString" && ts.isIdentifier(node.expression.expression)) browserNames.add(node.expression.expression.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) && docSaysBrowser(node)) browser.push([node.getStart(sf), node.getEnd()]);
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name) && TIMERS.has(node.name.text)) local.add(node.name.text);
    if (ts.isImportSpecifier(node) && TIMERS.has(node.name.text)) {
      const mod = node.parent.parent.parent.moduleSpecifier;
      if (!(ts.isStringLiteral(mod) && /^(node:)?timers\/promises$/.test(mod.text))) local.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  // same-file functions passed by name / serialized
  const markNamed = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && browserNames.has(node.name.text)) browser.push([node.getStart(sf), node.getEnd()]);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && browserNames.has(node.name.text) && node.initializer) browser.push([node.getStart(sf), node.getEnd()]);
    ts.forEachChild(node, markNamed);
  };
  markNamed(sf);

  const out = [];
  const flag = (node, what) => {
    const pos = node.getStart(sf);
    if (browser.some(([s, e]) => pos >= s && pos < e)) return;
    const line = sf.getLineAndCharacterOfPosition(pos).line;
    if (/clock-ok:/.test(lines[line] ?? "") || /^\s*\/\/.*clock-ok:/.test(lines[line - 1] ?? "")) return;
    out.push({ line: line + 1, text: `${what} — use clock.* from @jevitate/domain` });
  };
  const inType = (n) => {
    for (let q = n.parent; q !== undefined; q = q.parent) {
      if (ts.isTypeNode(q)) return true;
      if (ts.isStatement(q)) return false;
    }
    return false;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 0 && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.name.text === "now") {
      const obj = node.expression.expression.text;
      if (obj === "Date") flag(node, "Date.now()");
      if (obj === "performance") flag(node, "performance.now()");
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.name.text === "now" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      if (node.expression.text === "Date" || node.expression.text === "performance") flag(node, `${node.expression.text}.now (as a value)`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && (node.arguments === undefined || node.arguments.length === 0)) flag(node, "new Date()");
    if (ts.isIdentifier(node) && TIMERS.has(node.text) && !local.has(node.text)) {
      const p = node.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isMethodSignature(p);
      if (!isName && !inType(node)) flag(node, `global ${node.text}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(node:)?timers(\/promises)?$/.test(node.moduleSpecifier.text)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((e) => TIMERS.has((e.propertyName ?? e.name).text))) flag(node, `timers import from ${node.moduleSpecifier.text}`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f)) : sourceFiles();
  let n = 0;
  for (const f of files) {
    for (const v of checkSource(f, readFileSync(f, "utf8"))) {
      console.error(`${relative(REPO, f)}:${v.line}  ${v.text}`);
      n++;
    }
  }
  if (n > 0) {
    console.error(`\ncheck-clock: ${n} direct time/timer use(s) in Node source (#304). Route them through \`clock\` from @jevitate/domain,\nor mark genuine browser code / a justified exception (see scripts/check-clock.mjs).`);
    process.exit(1);
  }
  console.log(`check-clock: ok (${files.length} files)`);
}
