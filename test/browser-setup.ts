import { afterAll } from "vitest";
import { closeSharedBrowserPool, configureSharedBrowserPool } from "@jevitate/playwright";

/**
 * `browser` project setup: each test file gets its own module registry, hence
 * its own shared pool — ONE browser for the whole file, many contexts. Close it
 * when the file ends so no Chromium outlives its worker thread (thread workers
 * do not run process exit hooks).
 *
 * The test pool has its OWN admission config: a fixed resource sampler, so a
 * context is never held back by unrelated load on the host (other builds, other
 * agents). Concurrency stays bounded by the context cap and by vitest running at
 * most two browser files at once — test outcomes must not depend on host load.
 */
configureSharedBrowserPool({
  signals: {
    sample: async () => ({ memAvailableBytes: Number.MAX_SAFE_INTEGER, source: "test-harness (host load not gated)" }),
  },
  maxContexts: 4,
});

afterAll(async () => {
  await closeSharedBrowserPool();
});
