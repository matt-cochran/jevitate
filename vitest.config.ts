import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@jevitate/domain": pkg("domain"),
      "@jevitate/secrets": pkg("secrets"),
      "@jevitate/application": pkg("application"),
      "@jevitate/recording": pkg("recording"),
      "@jevitate/interpreter": pkg("interpreter"),
      "@jevitate/journey": pkg("journey"),
      "@jevitate/recorder": pkg("recorder"),
      "@jevitate/storage-sqlite": pkg("storage-sqlite"),
      "@jevitate/daemon": pkg("daemon"),
      "@jevitate/mcp-facade": pkg("mcp-facade"),
      "@jevitate/cli": pkg("cli"),
      "@jevitate/playwright": pkg("playwright"),
      "@jevitate/screenplay": pkg("screenplay"),
      "@jevitate/site-sdk": pkg("site-sdk"),
      "@jevitate/runtime": pkg("runtime"),
      "@jevitate/load": pkg("load"),
      "@jevitate/ai-core": pkg("ai-core"),
      "@jevitate/explore": pkg("explore"),
      "@jevitate/sources": pkg("sources"),
      "@jevitate/missions": pkg("missions"),
      "@jevitate/regression": pkg("regression"),
      "@jevitate/skills": pkg("skills"),
      "@jevitate/ux": pkg("ux"),
      "@jevitate/findings": pkg("findings"),
      // Add one line per new package here, e.g.:
      "@jevitate/example-site": fileURLToPath(new URL("./apps/example-site/src/index.ts", import.meta.url)),
      "@jevitate/site-example-network": fileURLToPath(new URL("./site-integrations/example-network/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "site-integrations/**/*.test.ts",
      "apps/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    // Sweeps throwaway temp dirs the fixtures leak into os.tmpdir() at the end
    // of a run (a full run otherwise leaks ~0.5 GB). See test/global-temp-cleanup.ts.
    globalSetup: ["./test/global-temp-cleanup.ts"],
    // Tests check the inbox store's and SQLite store's logic, not the disk flush; with fsync on, a
    // test's duration followed the HOST's disk writeback (seconds under memory pressure), turning
    // fast I/O tests into load-dependent timeouts. Production never sets this (see durability.ts).
    env: { JEVITATE_DURABLE_WRITES: "off" },
    // Only the workspace's `browser` project runs on threads (see
    // vitest.workspace.ts): at most two real-Chromium test files at once.
    poolOptions: { threads: { maxThreads: 2, minThreads: 1 } },
  },
});
