import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL(".", import.meta.url);
const FORBIDDEN = /^(node:|playwright|@jevitate\/|openai|@typesafe)/;

describe("adjudicator purity", () => {
  it("depends on zod only", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
  });

  it("imports nothing impure from non-test sources", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(new URL(f, dir), "utf8");
      const re = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
      for (const m of text.matchAll(re)) if (FORBIDDEN.test(m[1]!)) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
