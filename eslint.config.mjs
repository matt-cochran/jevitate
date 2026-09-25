import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const boundaryRule = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "playwright", message: "domain/site modules must not import playwright" },
        { name: "better-sqlite3", message: "domain/site modules must not import a db driver" },
        { name: "kysely", message: "domain/site modules must not import a db driver" },
      ],
    },
  ],
};

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
  },
  {
    // Boundary rule: domain must stay free of
    // browser/db driver dependencies. Scoped here (not globally) so
    // packages that legitimately need playwright/better-sqlite3/kysely
    // (e.g. storage-sqlite, a future automation-runner) are unaffected.
    files: ["packages/domain/**/*.ts"],
    rules: boundaryRule,
  },
];
