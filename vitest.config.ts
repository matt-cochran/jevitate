import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@doit/domain": pkg("domain"),
      "@doit/application": pkg("application"),
      "@doit/storage-sqlite": pkg("storage-sqlite"),
      "@doit/daemon": pkg("daemon"),
      "@doit/mcp-facade": pkg("mcp-facade"),
      "@doit/cli": pkg("cli"),
      "@doit/playwright": pkg("playwright"),
      "@doit/screenplay": pkg("screenplay"),
      "@doit/site-sdk": pkg("site-sdk"),
      // Add one line per new package here, e.g.:
    },
  },
  test: { include: ["packages/**/*.test.ts", "site-integrations/**/*.test.ts"] },
});
