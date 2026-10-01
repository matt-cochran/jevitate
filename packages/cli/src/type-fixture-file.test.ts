import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeFixtureSpecError } from "@jevitate/explore";
import { loadTypeFixtures, TYPE_FIXTURE_MAX_BYTES } from "./type-fixture-file.js";

/** #281: `--type-fixture` files are read and checked before any browser opens; errors name the path, never the contents. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-type-fixture-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadTypeFixtures (#281)", () => {
  it("reads the exact text (line breaks kept, a BOM dropped) and names the fixture by its file", () => {
    writeFileSync(join(dir, "import.txt"), "﻿First paragraph.\r\n\r\nSecond, with  two spaces.\n");
    const [f] = loadTypeFixtures(["label=Paste your text=import.txt"], dir);
    expect(f).toMatchObject({ descriptor: "label=Paste your text", name: "import.txt", text: "First paragraph.\r\n\r\nSecond, with  two spaces.\n" });
  });

  it("refuses a missing, directory, oversized, binary or empty file — naming the path only", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "big.txt"), "x".repeat(TYPE_FIXTURE_MAX_BYTES + 1));
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));
    writeFileSync(join(dir, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    writeFileSync(join(dir, "empty.txt"), "  \n");
    const err = (spec: string): string => {
      try {
        loadTypeFixtures([spec], dir);
      } catch (e) {
        expect(e).toBeInstanceOf(TypeFixtureSpecError);
        return (e as Error).message;
      }
      throw new Error("expected a refusal");
    };
    expect(err("label=Body=nope.txt")).toMatch(/file not found: nope\.txt/);
    expect(err("label=Body=sub")).toMatch(/is not a file/);
    expect(err("label=Body=big.txt")).toMatch(/at most/);
    expect(err("label=Body=bin.dat")).toMatch(/NUL byte/);
    expect(err("label=Body=bad.txt")).toMatch(/not UTF-8/);
    expect(err("label=Body=empty.txt")).toMatch(/is empty/);
    expect(err("Body=x.txt")).toMatch(/expects/);
  });
});
