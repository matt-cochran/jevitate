import { GENERATED_BUILT_AT, GENERATED_COMMIT, GENERATED_TREE } from "./build-info.generated.js";
import { readCliVersion } from "./version.js";

/**
 * Build identity for every mission result, issue draft, and `--version` (issue #83): "It's hard
 * to attribute results to a build" — the dev workflow (`npm link` to a live working tree) means
 * `jevitate --version`'s package.json number alone doesn't change between rebuilds, so two
 * results from different builds in the same dogfooding session were indistinguishable.
 *
 * `commit`/`builtAt` come from ONE of two places, and both fall back to `"unknown"` — never a
 * fabricated value:
 *
 *  - the esbuild bundle (`pnpm --filter @jevitate/cli run bundle`, what npm actually publishes)
 *    folds them in as literals via an esbuild `define` (`build.mjs`), computed there from
 *    `git rev-parse` at bundle time;
 *  - the plain `tsc --build` dist (what a dev `npm link` install runs — no bundler
 *    substitution ever touches it) reads the SAME git-rev-parse-or-"unknown" computation from a
 *    small generated module written just before `tsc --build` runs
 *    (`scripts/generate-build-info.mjs`, hooked into the package's "build" script).
 *
 * Both compute identically; only the injection mechanism differs by build path, so this module
 * simply prefers whichever one actually ran.
 */
export interface EngineInfo {
  readonly version: string;
  readonly commit: string;
  readonly builtAt: string;
}

// Ambient — populated by esbuild's `define` in the bundle build; simply absent (not a real
// binding at all) in the tsc build. `typeof` never throws on an unresolved identifier, so
// reading these through the guards below is safe either way.
declare const __JEVITATE_BUILD_COMMIT__: string;
declare const __JEVITATE_BUILT_AT__: string;
declare const __JEVITATE_BUILD_TREE__: string;

function bundledCommit(): string | undefined {
  return typeof __JEVITATE_BUILD_COMMIT__ !== "undefined" ? __JEVITATE_BUILD_COMMIT__ : undefined;
}

function bundledBuiltAt(): string | undefined {
  return typeof __JEVITATE_BUILT_AT__ !== "undefined" ? __JEVITATE_BUILT_AT__ : undefined;
}

function bundledTree(): string | undefined {
  return typeof __JEVITATE_BUILD_TREE__ !== "undefined" ? __JEVITATE_BUILD_TREE__ : undefined;
}

/**
 * The git tree this build was made from, short hash or `"unknown"` (#534). Kept out of
 * `EngineInfo` (and so out of every result envelope's schema): it is for `--version`, where it ties
 * a build packed from a dev commit to the staging/main merge commit that released it, since all
 * three share one tree (`git rev-parse --short <commit>^{tree}`).
 */
export function currentBuildTree(): string {
  return bundledTree() ?? GENERATED_TREE;
}

/**
 * `--version`'s display string: the published semver alone when the build could determine
 * neither commit nor build time, else `x.y.z (commit <sha>, tree <tree>, built <iso>)`. The
 * tree part is omitted (never fabricated) when it is `"unknown"`.
 */
export function formatVersion(engine: EngineInfo, tree: string = currentBuildTree()): string {
  if (engine.commit === "unknown" && engine.builtAt === "unknown") return engine.version;
  const treePart = tree === "unknown" ? "" : `, tree ${tree}`;
  return `${engine.version} (commit ${engine.commit}${treePart}, built ${engine.builtAt})`;
}

/** This build's identity: the published version plus which commit/build produced it. */
export function currentEngineInfo(): EngineInfo {
  return {
    version: readCliVersion(),
    commit: bundledCommit() ?? GENERATED_COMMIT,
    builtAt: bundledBuiltAt() ?? GENERATED_BUILT_AT,
  };
}

/**
 * Stamps a CLI result with the build that produced it (#112) — every envelope a command emits
 * (`journey run`, `load run`, `source run`, `verify-fix`, `regression capture`, `ux`) carries the
 * same `engine` the explore results do, so evidence from any surface can be tied to a build.
 */
export function withEngine<T extends object>(result: T, engine: EngineInfo = currentEngineInfo()): T & { engine: EngineInfo } {
  return { ...result, engine };
}
