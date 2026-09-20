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
      "@jevitate/sources": pkg("sources"),
      "@jevitate/regression": pkg("regression"),
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
  },
});
