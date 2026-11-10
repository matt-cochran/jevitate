import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adjudicate, rejudge } from "./adjudicate.js";
import { RunEvidenceSchema } from "./evidence.js";

/**
 * The recorded evidence (#812): `fixtures/<row>.evidence.json` came once from the soundness suite's rows
 * (packages/cli/src/journey-verify-soundness-served.test.ts) and the H1/H2 shapes of
 * journey-verify-dropped-write.test.ts, via JEVITATE_RECORD_EVIDENCE. `fixtures/expected.json` holds the
 * verdict each was adjudicated to when recorded. A rule change that moves any of them fails here by name.
 */

const dir = new URL("../fixtures/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".evidence.json")).sort();
const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")) as Record<string, unknown>;
const load = (f: string) => RunEvidenceSchema.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8")));

/**
 * The soundness suite's rows: 20 (kind, relation) lines times 5 timing columns. That suite lives in the
 * cli, which the adjudicator may not import, so the count is pinned here (its ROWS are not exported).
 * Rows share proofs, so the suite's proofs, one fixture each, are the matrix's 50 plus its experiment
 * rows; every fixture not from the dropped-write file is one of them.
 */
const SOUNDNESS_ROWS = 100;

describe("recorded evidence fixtures", () => {
  it("has at least one fixture per soundness row, and an expected verdict for exactly the fixtures", () => {
    expect(files.filter((f) => !f.startsWith("dropped-write-")).length).toBeGreaterThanOrEqual(SOUNDNESS_ROWS);
    expect(files.filter((f) => f.startsWith("dropped-write-")).length).toBeGreaterThan(0);
    expect(Object.keys(expected).sort()).toEqual(files);
  });

  it.each(files)("%s adjudicates to its recorded verdict", (f) => {
    expect(adjudicate(load(f))).toEqual(expected[f]);
  });

  it("every fixture re-judges v1 -> v1 with nothing moved", () => {
    for (const f of files) expect(rejudge(load(f), "v1", "v1").moved, f).toEqual([]);
  });
});
