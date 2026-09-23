import { afterAll } from "vitest";
import { closeSharedBrowserPool } from "@jevitate/playwright";

/**
 * `browser` project setup: each test file gets its own module registry, hence
 * its own shared pool — ONE browser for the whole file, many contexts. Close it
 * when the file ends so no Chromium outlives its worker thread (thread workers
 * do not run process exit hooks).
 */
afterAll(async () => {
  await closeSharedBrowserPool();
});
