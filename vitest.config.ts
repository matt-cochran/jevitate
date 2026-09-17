import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@doit/domain": pkg("domain"),
      "@doit/application": pkg("application"),
      // Add one line per new package here, e.g.:
      // "@doit/storage-sqlite": pkg("storage-sqlite"),
    },
  },
  test: { include: ["packages/**/*.test.ts", "site-integrations/**/*.test.ts"] },
});
