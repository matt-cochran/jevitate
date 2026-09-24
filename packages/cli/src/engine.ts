import { GENERATED_BUILT_AT, GENERATED_COMMIT } from "./build-info.generated.js";
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

function bundledCommit(): string | undefined {
  return typeof __JEVITATE_BUILD_COMMIT__ !== "undefined" ? __JEVITATE_BUILD_COMMIT__ : undefined;
}

function bundledBuiltAt(): string | undefined {
  return typeof __JEVITATE_BUILT_AT__ !== "undefined" ? __JEVITATE_BUILT_AT__ : undefined;
}

/** This build's identity: the published version plus which commit/build produced it. */
export function currentEngineInfo(): EngineInfo {
  return {
    version: readCliVersion(),
    commit: bundledCommit() ?? GENERATED_COMMIT,
    builtAt: bundledBuiltAt() ?? GENERATED_BUILT_AT,
  };
}
