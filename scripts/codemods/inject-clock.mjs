#!/usr/bin/env node
// #304 codemod: route Node-side timing through the injectable clock (`clock` from @jevitate/domain).
//
// Rewrites, in every package's non-test source (the files its tsconfig compiles):
//   Date.now()                              → clock.now()
//   new Date().toISOString()                → clock.nowIso()
//   new Date()            (no arguments)    → new Date(clock.now())
//   performance.now()                       → clock.monotonicMs()
//   Date.now / performance.now as a value   → clock.now / clock.monotonicMs
//   setTimeout / clearTimeout / setInterval / clearInterval   (the GLOBALS) → clock.<same>
//   new Promise((r) => setTimeout(r, ms))   → clock.sleep(ms)
//   import { setTimeout as X } from "node:timers/promises";  X(ms)  → clock.sleep(ms)
// and adds `import { clock } from "@jevitate/domain"` (aliased when `clock` is taken), plus the
// @jevitate/domain dependency / tsconfig reference to a package that lacks it.
//
// Names are resolved with the TypeScript type checker: only the platform globals are rewritten
// (a local `sleep`, an injected `deps.setTimeout`, a type `ReturnType<typeof setTimeout>` are not).
//
// SKIPPED — code that runs INSIDE THE BROWSER keeps native timers (page time is `page.clock`'s job):
//   - a function passed to page/frame/locator `evaluate*` / `$eval` / `$$eval` / `addInitScript` /
//     `waitForFunction`, inline OR by reference (resolved through imports to its declaration);
//   - a declaration whose doc comment says `BROWSER CODE` (the repo's convention);
//   - any function that touches the DOM globals `window` / `document` (reported as heuristic);
//   - a function serialized with `fn.toString()` (an init script built from source);
//   - a file carrying the marker comment `@jevitate-browser-code` (or a header saying "THIS FILE IS BROWSER CODE");
//   - string-literal scripts are never code to the compiler, so they are untouched by construction.
//
// Usage: node scripts/codemods/inject-clock.mjs [--dry-run] [--verbose]
//   --dry-run  print every planned change grouped by file (and the skip list), write nothing.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const CLOCK_MODULE = join(REPO, "packages/domain/src/clock.ts");

const BROWSER_CALLEES = new Set(["evaluate", "evaluateHandle", "evaluateAll", "$eval", "$$eval", "addInitScript", "waitForFunction"]);
const TIMER_GLOBALS = new Set(["setTimeout", "clearTimeout", "setInterval", "clearInterval"]);
const FILE_MARKER = "@jevitate-browser-code";

// ── Program over every package's compiled (non-test) source ────────────────────────────────────

/** @returns {{ dir: string, name: string, files: string[] }[]} */
function projects() {
  const out = [];
  // apps/example-site is the fixture site the tests drive (its own server); it is not jevitate code.
  const roots = [join(REPO, "packages")];
  for (const root of roots) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(root, d.name);
      const tsconfig = join(dir, "tsconfig.json");
      if (!existsSync(tsconfig) || !existsSync(join(dir, "src"))) continue;
      const cfg = ts.readConfigFile(tsconfig, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir);
      const files = parsed.fileNames.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !/\.test\.ts$/.test(f) && f.startsWith(join(dir, "src")));
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      out.push({ dir, name: pkg.name, files });
    }
  }
  return out;
}

const PROJECTS = projects();
const ALL_FILES = PROJECTS.flatMap((p) => p.files);
const paths = {};
for (const p of PROJECTS) paths[p.name] = [relative(REPO, join(p.dir, "src/index.ts"))];

const program = ts.createProgram(ALL_FILES, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  baseUrl: REPO,
  paths,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
});
const checker = program.getTypeChecker();

/** True when `id` resolves to a platform global (declared only in lib / @types files). */
function isGlobal(id) {
  let sym = checker.getSymbolAtLocation(id);
  if (sym === undefined) return true; // unresolved free name: only a global can be unresolved here
  if (sym.flags & ts.SymbolFlags.Alias) return false; // an import
  const decls = sym.declarations ?? [];
  if (decls.length === 0) return true;
  return decls.every((d) => {
    const sf = d.getSourceFile();
    return sf.isDeclarationFile && (program.isSourceFileDefaultLibrary(sf) || sf.fileName.includes("/node_modules/"));
  });
}

const rel = (f) => relative(REPO, f);
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// ── Pass 1: browser-code ranges (across files) ─────────────────────────────────────────────────

/** file → [{start,end,why}] */
const browserRanges = new Map();
const skipList = [];
function addRange(node, why) {
  const sf = node.getSourceFile();
  const list = browserRanges.get(sf.fileName) ?? [];
  if (list.some((r) => r.start === node.getStart(sf) && r.end === node.getEnd())) return;
  list.push({ start: node.getStart(sf), end: node.getEnd(), why });
  browserRanges.set(sf.fileName, list);
}

/** The declaration node (function / variable statement) an argument expression refers to. */
function declarationOf(expr) {
  let sym = checker.getSymbolAtLocation(expr);
  if (sym === undefined) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const d = sym.valueDeclaration ?? sym.declarations?.[0];
  if (d === undefined) return undefined;
  if (ts.isVariableDeclaration(d)) return d.initializer !== undefined ? d : undefined;
  if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isPropertyDeclaration(d)) return d;
  return undefined;
}

function hasBrowserDoc(node, sf) {
  let target = node;
  if (ts.isVariableDeclaration(node) && node.parent?.parent && ts.isVariableStatement(node.parent.parent)) target = node.parent.parent;
  const ranges = ts.getLeadingCommentRanges(sf.text, target.getFullStart()) ?? [];
  return ranges.some((r) => /BROWSER CODE/.test(sf.text.slice(r.pos, r.end)));
}

for (const file of ALL_FILES) {
  const sf = program.getSourceFile(file);
  if (sf === undefined) continue;
  if (sf.text.includes(FILE_MARKER) || /FILE IS BROWSER CODE/.test(sf.text.slice(0, 2_000))) {
    addRange(sf, "file marker");
    continue;
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name !== undefined && BROWSER_CALLEES.has(name)) {
        for (const arg of node.arguments) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) addRange(arg, `inline ${name}() argument`);
          else if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
            const d = declarationOf(arg);
            if (d !== undefined) addRange(d, `passed to ${name}() at ${rel(file)}:${lineOf(sf, node.getStart(sf))}`);
          }
        }
      }
    }
    // `fn.toString()` — a function serialized into an init script / evaluate string.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toString" && node.arguments.length === 0) {
      const d = declarationOf(node.expression.expression);
      if (d !== undefined) addRange(d, `serialized by .toString() at ${rel(file)}:${lineOf(sf, node.getStart(sf))}`);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) && hasBrowserDoc(node, sf)) {
      addRange(node, "BROWSER CODE doc comment");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function browserRangeFor(sf, pos) {
  return (browserRanges.get(sf.fileName) ?? []).find((r) => pos >= r.start && pos < r.end);
}

/** The innermost function enclosing `node` that references the DOM globals, if any. */
function domFunctionFor(node) {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p) && p.body !== undefined) {
      let dom = false;
      const walk = (n) => {
        if (dom) return;
        if (ts.isFunctionLike(n)) return; // a nested function is judged on its own body
        if (ts.isIdentifier(n) && (n.text === "window" || n.text === "document") && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && isGlobal(n)) dom = true;
        else ts.forEachChild(n, walk);
      };
      ts.forEachChild(p.body, walk);
      if (dom) return p;
    }
  }
  return undefined;
}

// ── Pass 2: planned edits ──────────────────────────────────────────────────────────────────────

const plans = []; // { file, sf, edits: [{start,end,text,label,line}], clockName, importFrom }
const stats = { files: 0, edits: 0, byKind: {} };

function clockNameFor(sf) {
  let taken = false;
  const walk = (n) => {
    if (taken) return;
    if (ts.isIdentifier(n) && n.text === "clock") {
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertyDeclaration(p) && p.name === n);
      if (!isPropName) taken = true;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return taken ? "sysClock" : "clock";
}

/** Single-arrow sleep: `new Promise((r) => setTimeout(r, ms))` → the `ms` expression, else undefined. */
function sleepArg(node) {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "Promise") return undefined;
  const [fn] = node.arguments ?? [];
  if (fn === undefined || node.arguments.length !== 1 || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return undefined;
  if (fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name)) return undefined;
  const param = fn.parameters[0].name.text;
  let call = fn.body;
  if (ts.isBlock(call)) {
    if (call.statements.length !== 1 || !ts.isExpressionStatement(call.statements[0])) return undefined;
    call = call.statements[0].expression;
  }
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "setTimeout" || !isGlobal(call.expression)) return undefined;
  if (call.arguments.length !== 2 || !ts.isIdentifier(call.arguments[0]) || call.arguments[0].text !== param) return undefined;
  return call.arguments[1];
}

for (const project of PROJECTS) {
  for (const file of project.files) {
    if (resolve(file) === CLOCK_MODULE) continue;
    const sf = program.getSourceFile(file);
    if (sf === undefined) continue;
    const edits = [];
    const C = clockNameFor(sf);
    const skip = (node, why) => {
      skipList.push(`${rel(file)}:${lineOf(sf, node.getStart(sf))}  ${node.getText(sf).split("\n")[0].slice(0, 70)}  [${why}]`);
    };
    const guard = (node) => {
      const r = browserRangeFor(sf, node.getStart(sf));
      if (r !== undefined) {
        skip(node, `browser: ${r.why}`);
        return false;
      }
      const dom = domFunctionFor(node);
      if (dom !== undefined) {
        skip(node, "browser (heuristic): enclosing function uses window/document");
        return false;
      }
      return true;
    };
    const add = (node, text, kind) => {
      edits.push({ start: node.getStart(sf), end: node.getEnd(), text, kind, line: lineOf(sf, node.getStart(sf)), before: node.getText(sf) });
    };

    // node:timers/promises `setTimeout as X` imports → clock.sleep
    const timersPromiseSleeps = new Set();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !/^(node:)?timers\/promises$/.test(st.moduleSpecifier.text)) continue;
      const named = st.importClause?.namedBindings;
      if (named === undefined || !ts.isNamedImports(named)) continue;
      const keep = named.elements.filter((e) => (e.propertyName ?? e.name).text !== "setTimeout");
      const sleeps = named.elements.filter((e) => (e.propertyName ?? e.name).text === "setTimeout");
      if (sleeps.length === 0) continue;
      for (const e of sleeps) timersPromiseSleeps.add(checker.getSymbolAtLocation(e.name));
      const text = keep.length === 0 ? "" : `import { ${keep.map((e) => e.getText(sf)).join(", ")} } from ${st.moduleSpecifier.getText(sf)};`;
      edits.push({ start: st.getStart(sf), end: st.getEnd() + (keep.length === 0 && sf.text[st.getEnd()] === "\n" ? 1 : 0), text, kind: "timers/promises import", line: lineOf(sf, st.getStart(sf)), before: st.getText(sf) });
    }

    const visit = (node) => {
      // new Promise((r) => setTimeout(r, ms))  → clock.sleep(ms)
      const ms = sleepArg(node);
      if (ms !== undefined) {
        if (guard(node)) {
          add(node, `${C}.sleep(${ms.getText(sf)})`, "sleep");
          return; // the inner setTimeout is consumed
        }
        return;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.arguments.length === 0) {
        const obj = node.expression.expression;
        const prop = node.expression.name.text;
        if (obj.text === "Date" && prop === "now" && isGlobal(obj)) {
          if (guard(node)) add(node, `${C}.now()`, "Date.now()");
          return;
        }
        if (obj.text === "performance" && prop === "now" && isGlobal(obj)) {
          if (guard(node)) add(node, `${C}.monotonicMs()`, "performance.now()");
          return;
        }
      }
      // Date.now / performance.now used as a value (a default `now` function, say)
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.name.text === "now" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const obj = node.expression;
        if ((obj.text === "Date" || obj.text === "performance") && isGlobal(obj)) {
          if (guard(node)) add(node, obj.text === "Date" ? `${C}.now` : `${C}.monotonicMs`, `${obj.text}.now (value)`);
          return;
        }
      }
      // new Date().toISOString()  → clock.nowIso()
      if (ts.isCallExpression(node) && node.arguments.length === 0 && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toISOString") {
        const inner = node.expression.expression;
        const nd = ts.isParenthesizedExpression(inner) ? inner.expression : inner;
        if (ts.isNewExpression(nd) && ts.isIdentifier(nd.expression) && nd.expression.text === "Date" && (nd.arguments === undefined || nd.arguments.length === 0) && isGlobal(nd.expression)) {
          if (guard(node)) add(node, `${C}.nowIso()`, "new Date().toISOString()");
          return;
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && (node.arguments === undefined || node.arguments.length === 0) && isGlobal(node.expression)) {
        if (guard(node)) add(node, `new Date(${C}.now())`, "new Date()");
        return;
      }
      if (ts.isIdentifier(node) && TIMER_GLOBALS.has(node.text)) {
        const p = node.parent;
        const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || ts.isPropertyAssignment(p) && p.name === node || ts.isImportSpecifier(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p);
        const inType = (() => {
          for (let q = p; q !== undefined; q = q.parent) {
            if (ts.isTypeNode(q) || ts.isTypeQueryNode(q)) return true;
            if (ts.isStatement(q) || ts.isExpressionStatement(q)) return false;
          }
          return false;
        })();
        if (!isName && !inType && isGlobal(node)) {
          if (guard(node)) add(node, ts.isShorthandPropertyAssignment(p) ? `${node.text}: ${C}.${node.text}` : `${C}.${node.text}`, node.text);
        }
        return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && timersPromiseSleeps.size > 0) {
        const sym = checker.getSymbolAtLocation(node.expression);
        if (sym !== undefined && timersPromiseSleeps.has(sym)) {
          if (node.arguments.length !== 1) throw new Error(`${rel(file)}:${lineOf(sf, node.getStart(sf))}: timers/promises setTimeout with a value/options argument — handle by hand`);
          if (guard(node)) add(node, `${C}.sleep(${node.arguments[0].getText(sf)})`, "timers/promises sleep");
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (edits.length === 0) continue;

    // import { clock } from "@jevitate/domain" (relative inside the domain package)
    const inDomain = file.startsWith(join(REPO, "packages/domain/src"));
    const from = inDomain ? "./" + relative(dirname(file), CLOCK_MODULE).replace(/\.ts$/, ".js").replace(/^\.\//, "") : "@jevitate/domain";
    const spec = C === "clock" ? "clock" : `clock as ${C}`;
    const existing = sf.statements.find((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === from && !s.importClause?.isTypeOnly && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings));
    if (existing !== undefined) {
      const named = existing.importClause.namedBindings;
      const last = named.elements[named.elements.length - 1];
      edits.push({ start: last.getEnd(), end: last.getEnd(), text: `, ${spec}`, kind: "import", line: lineOf(sf, existing.getStart(sf)), before: "" });
    } else {
      const imports = sf.statements.filter((s) => ts.isImportDeclaration(s));
      const anchor = imports.length > 0 ? imports[imports.length - 1].getEnd() : undefined;
      const text = `import { ${spec} } from "${from}";`;
      if (anchor !== undefined) edits.push({ start: anchor, end: anchor, text: `\n${text}`, kind: "import", line: lineOf(sf, anchor), before: "" });
      else {
        const first = sf.statements[0];
        const at = first ? first.getStart(sf) : 0;
        edits.push({ start: at, end: at, text: `${text}\n\n`, kind: "import", line: lineOf(sf, at), before: "" });
      }
    }
    plans.push({ file, project, sf, edits });
  }
}

// ── Report / apply ─────────────────────────────────────────────────────────────────────────────

const depsToAdd = new Set();
for (const plan of plans) {
  const n = plan.edits.filter((e) => e.kind !== "import").length;
  stats.files++;
  stats.edits += n;
  for (const e of plan.edits) if (e.kind !== "import") stats.byKind[e.kind] = (stats.byKind[e.kind] ?? 0) + 1;
  if (plan.project.name !== "@jevitate/domain") {
    const pkg = JSON.parse(readFileSync(join(plan.project.dir, "package.json"), "utf8"));
    if (!pkg.dependencies?.["@jevitate/domain"] && !pkg.devDependencies?.["@jevitate/domain"]) depsToAdd.add(plan.project.dir);
  }
  if (DRY || VERBOSE) {
    console.log(`\n${rel(plan.file)}  (${n} change${n === 1 ? "" : "s"})`);
    for (const e of [...plan.edits].sort((a, b) => a.start - b.start)) {
      console.log(`  L${e.line}  ${e.before === "" ? "+" : e.before.split("\n")[0].slice(0, 80)}  →  ${e.text.trim() === "" ? "(removed)" : e.text.trim()}`);
    }
  }
}

console.log(`\nSKIPPED (browser code keeps native timers): ${skipList.length}`);
for (const s of skipList) console.log(`  ${s}`);
console.log(`\nPackages gaining a @jevitate/domain dependency: ${[...depsToAdd].map(rel).join(", ") || "(none)"}`);
console.log(`\n${DRY ? "PLANNED" : "APPLIED"}: ${stats.edits} rewrites in ${stats.files} files — ${JSON.stringify(stats.byKind)}`);

if (!DRY) {
  for (const plan of plans) {
    let text = plan.sf.text;
    for (const e of [...plan.edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    writeFileSync(plan.file, text);
  }
  for (const dir of depsToAdd) {
    const pj = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    pkg.dependencies = { "@jevitate/domain": "workspace:*", ...(pkg.dependencies ?? {}) };
    writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n");
    const tj = join(dir, "tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tj, "utf8"));
    const refs = tsconfig.references ?? [];
    if (!refs.some((r) => r.path === "../domain")) {
      tsconfig.references = [{ path: "../domain" }, ...refs];
      writeFileSync(tj, JSON.stringify(tsconfig, null, 2) + "\n");
    }
  }
  if (depsToAdd.size > 0) console.log("Run `pnpm install --offline` to link the new workspace dependencies.");
}
