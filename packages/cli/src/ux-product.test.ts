import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProductFactsError } from "@jevitate/ux";
import { loadProductFacts, productFactsPath } from "./ux-product.js";

const root = mkdtempSync(join(tmpdir(), "jev-ux-product-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("#198: product facts discovery and loading", () => {
  const repo = join(root, "repo");
  const sub = join(repo, "app", "src");
  mkdirSync(join(repo, ".jevitate"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  const deps = { cwd: () => sub, homedir: () => join(root, "home") };

  it("no facts file in the project: nothing is loaded (the report says so)", async () => {
    expect(productFactsPath(undefined, deps)).toBeUndefined();
    expect(await loadProductFacts(undefined, deps)).toEqual({});
  });

  it("discovers <project>/.jevitate/product.json walking up from the working directory", async () => {
    const file = join(repo, ".jevitate", "product.json");
    writeFileSync(file, JSON.stringify({ version: 1, plans: [{ name: "Pro", prices: [{ amount: 149, interval: "month" }] }] }));
    expect(productFactsPath(undefined, deps)).toBe(file);
    const loaded = await loadProductFacts(undefined, deps);
    expect(loaded.path).toBe(file);
    expect(loaded.facts?.plans[0]?.name).toBe("Pro");
  });

  it("--product wins; a missing or invalid file is a typed refusal", async () => {
    await expect(loadProductFacts(join(root, "nope.json"), deps)).rejects.toBeInstanceOf(ProductFactsError);
    const bad = join(root, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, pages: [{ route: "no-slash", nextStep: "Go" }] }));
    await expect(loadProductFacts(bad, deps)).rejects.toThrow(/pages\[0\]\.route/);
    await expect(loadProductFacts(bad, deps)).rejects.toMatchObject({ code: "E_UX_PRODUCT_INPUT" });
  });
});
