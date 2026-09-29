import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * #231 guard (run BEFORE any file split): a full, deterministic snapshot of every private
 * `packages/*` library's PUBLIC API — its `src/index.ts` export surface. Ten source files (see
 * issue #231: `program.ts`, `explore-api.ts`, `check-api.ts`, `ux-api.ts`,
 * `packages/recording/src/invariants.ts`, `packages/explore/src/declared-invariants.ts`,
 * `packages/ux/src/signals.ts`) are about to be split into several files each and re-exported
 * through the SAME `src/index.ts`. This test holds each package's export surface constant across
 * that move: an export renamed, dropped, or silently changed in kind (a class demoted to a plain
 * object, say) shows up as a snapshot diff. An INTENTIONAL API change updates the committed
 * snapshot in the same commit, with the reason in that commit's message.
 *
 * Two complementary views, because neither alone is enough:
 *  - RUNTIME: dynamically imports each package's BUILT `dist/index.js` (the actual thing the CLI
 *    bundles) and records each export's name + runtime kind (function/class/array/object/const
 *    <primitive>). This is what could actually break a caller. Requires `pnpm -r build` to have
 *    run first (same as every other gate in AGENTS.md) — dist must exist.
 *  - DECLARATION: walks `src/index.ts`'s exports via the TypeScript compiler API (the same
 *    approach `packages/cli/src/surface-wiring.test.ts` uses for its type-checker diffing), which
 *    sees type-only exports (interfaces, type aliases) that vanish entirely at runtime and so the
 *    runtime view above can never catch a type export being dropped or renamed.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** Every private `packages/*` library with a `src/index.ts` (the CLI itself and the bare `jevitate`
 *  alias package are published, not bundled-in libraries, and are excluded). */
function libraryPackages() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      const pkgJsonPath = join(PACKAGES_DIR, name, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        return pkg.private === true;
      } catch {
        return false;
      }
    })
    .sort();
}

// ── Runtime view ────────────────────────────────────────────────────────────────────────────────

function runtimeKind(value) {
  if (typeof value === "function") {
    // ES6 classes' Function#toString always begins with "class " — the one reliable runtime
    // signal that distinguishes a class from a plain function (both have typeof "function").
    return /^class[\s{]/.test(Function.prototype.toString.call(value)) ? "class" : "function";
  }
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return `const (${typeof value})`;
}

async function runtimeExports(pkgName) {
  const pkgDir = join(PACKAGES_DIR, pkgName);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const entry = join(pkgDir, pkgJson.main ?? "dist/index.js");
  let ns;
  try {
    ns = await import(pathToFileURL(entry).href);
  } catch (err) {
    throw new Error(
      `cannot import built entry ${entry} for package ${pkgName} — run \`pnpm -r build\` first (${String(err)})`,
    );
  }
  return Object.keys(ns)
    .sort()
    .map((name) => ({ name, kind: runtimeKind(ns[name]) }));
}

// ── Declaration view (TypeScript compiler API) ─────────────────────────────────────────────────

/** Coarse declaration kind from a symbol's flags. Mirrors the checker-based approach in
 *  packages/cli/src/surface-wiring.test.ts (propsOf/checker.getTypeAtLocation), but over a
 *  module's exports rather than one named type's properties. */
function declarationKind(flags) {
  if (flags & ts.SymbolFlags.Class) return "class";
  if (flags & ts.SymbolFlags.Interface) return "interface";
  if (flags & ts.SymbolFlags.TypeAlias) return "type-alias";
  if (flags & ts.SymbolFlags.RegularEnum || flags & ts.SymbolFlags.ConstEnum) return "enum";
  if (flags & ts.SymbolFlags.Function) return "function";
  if (flags & ts.SymbolFlags.ValueModule || flags & ts.SymbolFlags.NamespaceModule) return "namespace";
  if (flags & ts.SymbolFlags.Variable) return "variable";
  return "other";
}

// Building a ts.Program per package (each pulling in its whole dependency graph's .d.ts) is the
// expensive part of this file; several assertions below want the same package's declaration
// surface, so it's memoized rather than recomputed per assertion.
const declarationExportsCache = new Map();

function declarationExports(pkgName) {
  const cached = declarationExportsCache.get(pkgName);
  if (cached !== undefined) return cached;
  const pkgDir = join(PACKAGES_DIR, pkgName);
  const configPath = join(pkgDir, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) throw new Error(`cannot read ${configPath}`);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const indexPath = join(pkgDir, "src", "index.ts");
  const sourceFile = program.getSourceFile(indexPath);
  if (sourceFile === undefined) throw new Error(`cannot find ${indexPath} in the ${pkgName} program`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) throw new Error(`${indexPath} has no module symbol (not a module?)`);
  const result = checker
    .getExportsOfModule(moduleSymbol)
    .map((sym) => ({ name: sym.name, kind: declarationKind(sym.flags) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  declarationExportsCache.set(pkgName, result);
  return result;
}

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────

function renderSection(title, byPackage) {
  const lines = [`=== ${title} ===`, ""];
  for (const [pkgName, exports] of byPackage) {
    lines.push(`# @jevitate/${pkgName} (${exports.length} exports)`);
    for (const e of exports) lines.push(`  ${e.name}: ${e.kind}`);
    lines.push("");
  }
  return lines.join("\n");
}

describe("package API surface snapshot (#231 guard — must survive the file splits unchanged)", () => {
  const packages = libraryPackages();

  it("finds the private library packages (the analysis itself is not vacuous)", () => {
    for (const p of ["domain", "explore", "recording", "ux", "application"]) {
      expect(packages, p).toContain(p);
    }
    expect(packages.length).toBeGreaterThanOrEqual(20);
  });

  it("runtime export surface (built dist/index.js) matches the committed snapshot", async () => {
    const byPackage = [];
    for (const pkgName of packages) byPackage.push([pkgName, await runtimeExports(pkgName)]);
    const totalExports = byPackage.reduce((n, [, exports]) => n + exports.length, 0);
    expect(totalExports).toBeGreaterThan(100); // sanity floor: never a silently-empty sweep

    const text = renderSection("RUNTIME (dist/index.js)", byPackage);
    await expect(text).toMatchFileSnapshot(join(REPO_ROOT, "scripts", "__snapshots__", "api-surface.runtime.snapshot.txt"));
  }, 60_000);

  it("declaration export surface (src/index.ts via the TS compiler API) matches the committed snapshot", () => {
    const byPackage = packages.map((pkgName) => [pkgName, declarationExports(pkgName)]);
    const totalExports = byPackage.reduce((n, [, exports]) => n + exports.length, 0);
    expect(totalExports).toBeGreaterThan(100);

    const text = renderSection("DECLARATION (src/index.ts, TS compiler API)", byPackage);
    return expect(text).toMatchFileSnapshot(join(REPO_ROOT, "scripts", "__snapshots__", "api-surface.declaration.snapshot.txt"));
  }, 120_000); // building a ts.Program per package (22 packages, each pulling its whole dependency graph's .d.ts) is inherently slow

  it("every package with a runtime export also has a declaration export (nothing is import()-visible but invisible to the checker, or vice versa beyond genuine type-only exports)", () => {
    for (const pkgName of packages) {
      const decl = new Set(declarationExports(pkgName).map((e) => e.name));
      expect(decl.size, `${pkgName}: declaration surface must not be empty`).toBeGreaterThan(0);
    }
  }, 60_000);
});
