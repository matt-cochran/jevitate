// ux-product.ts — finding and loading the product facts file for the UX review (#198).
//
// `--product <file>` wins; otherwise the project's `.jevitate/product.json` (found by walking up
// from the working directory, like every other in-repo `.jevitate/` file) is used when it exists.
// An unreadable or invalid file is a typed refusal (`E_UX_PRODUCT_INPUT`, usage error) BEFORE any
// browser opens — never a silently ignored file.
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductFactsError, parseProductFactsText, type ProductFacts } from "@jevitate/ux";
import { findProjectDir, type LayoutDeps } from "./project-dir.js";

export const PRODUCT_FACTS_FILE = "product.json";

export interface LoadedProductFacts {
  readonly facts?: ProductFacts;
  /** The file read, when one was. */
  readonly path?: string;
}

/** The facts file to read: the flag, else `<project>/.jevitate/product.json` when present. */
export function productFactsPath(flag: string | undefined, deps: LayoutDeps = {}): string | undefined {
  if (flag !== undefined) return flag;
  const dir = findProjectDir(deps);
  if (dir === null) return undefined;
  const p = join(dir, PRODUCT_FACTS_FILE);
  return existsSync(p) && statSync(p).isFile() ? p : undefined;
}

/** Reads and validates the product facts. Throws `ProductFactsError` for a missing/invalid file. */
export async function loadProductFacts(flag: string | undefined, deps: LayoutDeps = {}): Promise<LoadedProductFacts> {
  const path = productFactsPath(flag, deps);
  if (path === undefined) return {};
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ProductFactsError(path, [`cannot read the file: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return { facts: parseProductFactsText(text, path), path };
}

/** The report caveat when no facts were available (prices and intended next steps went unchecked). */
export const NO_PRODUCT_FACTS_CAVEAT =
  "no product facts (.jevitate/product.json or --product): prices, trial lengths and each page's intended next step were not checked against the product's own facts (docs/ux-findings.md).";
