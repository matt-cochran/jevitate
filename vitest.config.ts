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
      "@doit/example-site": fileURLToPath(new URL("./apps/example-site/src/index.ts", import.meta.url)),
      "@doit/site-example-network": fileURLToPath(new URL("./site-integrations/example-network/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["packages/**/*.test.ts", "site-integrations/**/*.test.ts", "apps/**/*.test.ts"] },
});
