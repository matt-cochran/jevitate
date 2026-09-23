import { fileURLToPath } from "node:url";
import { configDefaults, defineWorkspace } from "vitest/config";
import { browserSuites } from "./test/browser-suites.js";
import base from "./vitest.config.js";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const browser = browserSuites(repoRoot);

/**
 * Two projects sharing vitest.config.ts (aliases, globalSetup). The base is
 * spread rather than `extends`-ed: `extends` CONCATENATES arrays, which would
 * add the base `include` back into the browser project.
 *
 *  - `unit`: every test file that does NOT launch a real browser, at vitest's
 *    default file parallelism.
 *  - `browser`: files that launch real Chromium (see test/browser-suites.ts).
 *    Each file runs on ONE pooled browser (many contexts) and at most two such
 *    files run at once, so a loaded machine is not handed N Chromiums at the
 *    same moment; the admission-controlled pool paces contexts on top of that.
 *    Timeouts are browser-sized rather than vitest's 5s unit default.
 *
 * Run from the repo root with explicit paths (AGENTS.md), e.g.
 *   pnpm exec vitest run packages/explore/src
 */
export default defineWorkspace([
  {
    ...base,
    test: {
      ...base.test,
      name: "unit",
      exclude: [...configDefaults.exclude, ...browser],
    },
  },
  {
    ...base,
    test: {
      ...base.test,
      name: "browser",
      include: browser,
      pool: "forks",
      poolOptions: { forks: { maxForks: 2, minForks: 1 } },
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  },
]);
