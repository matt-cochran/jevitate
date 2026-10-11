import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FixturePathError, confineFixture, fixtureEscapesRoot } from "./fixture-path.js";

// #498: an upload fixture must resolve (after realpath) to a file inside the project root.
let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "fixture-path-")));
  root = join(base, "proj");
  await mkdir(join(root, "fixtures"), { recursive: true });
  await writeFile(join(root, "fixtures", "receipt.pdf"), "pdf");
  outside = join(base, "secret.txt");
  await writeFile(outside, "secret");
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof FixturePathError ? err.code : "other";
  }
}

describe("#498 confineFixture", () => {
  it("accepts a relative path inside the root, returning its real absolute path", async () => {
    expect(await confineFixture("fixtures/receipt.pdf", root)).toBe(join(root, "fixtures", "receipt.pdf"));
  });

  it("refuses a ../ path that escapes the root", async () => {
    expect(await codeOf(confineFixture("../secret.txt", root))).toBe("fixture-outside-project");
  });

  it("refuses an absolute path outside the root", async () => {
    expect(await codeOf(confineFixture(outside, root))).toBe("fixture-outside-project");
  });

  it("accepts an absolute path inside the root", async () => {
    expect(await confineFixture(join(root, "fixtures", "receipt.pdf"), root)).toBe(join(root, "fixtures", "receipt.pdf"));
  });

  it("refuses a symlink inside the root that points outside", async () => {
    await symlink(outside, join(root, "fixtures", "link.txt"));
    expect(await codeOf(confineFixture("fixtures/link.txt", root))).toBe("fixture-outside-project");
  });

  it("accepts a symlinked fixture that points inside the root, returning the target", async () => {
    await symlink(join(root, "fixtures", "receipt.pdf"), join(root, "alias.pdf"));
    expect(await confineFixture("alias.pdf", root)).toBe(join(root, "fixtures", "receipt.pdf"));
  });

  it("accepts a fixture under a symlinked root (real paths compared)", async () => {
    const linkedRoot = join(base, "proj-link");
    await symlink(root, linkedRoot);
    expect(await confineFixture("fixtures/receipt.pdf", linkedRoot)).toBe(join(root, "fixtures", "receipt.pdf"));
  });

  it("refuses a path through a symlinked directory inside the root that points outside", async () => {
    await symlink(base, join(root, "up"));
    expect(await codeOf(confineFixture("up/secret.txt", root))).toBe("fixture-outside-project");
  });

  it("refuses a missing path outside the root as outside, not as missing", async () => {
    expect(await codeOf(confineFixture("../nope.txt", root))).toBe("fixture-outside-project");
  });

  it("reports a missing fixture inside the root as fixture-not-found", async () => {
    expect(await codeOf(confineFixture("fixtures/missing.pdf", root))).toBe("fixture-not-found");
  });

  it("refuses a directory as fixture-not-found", async () => {
    expect(await codeOf(confineFixture("fixtures", root))).toBe("fixture-not-found");
  });

  it("fails closed with no root", async () => {
    expect(await codeOf(confineFixture(join(root, "fixtures", "receipt.pdf"), undefined))).toBe("fixture-no-root");
  });

  it("names the path, the root and the fix in the outside-project message", async () => {
    await expect(confineFixture(outside, root)).rejects.toThrow(`upload fixture ${outside} is outside the project root ${root} — move the fixture into the project`);
  });
});

describe("#498 fixtureEscapesRoot (lint, sync)", () => {
  it("flags an absolute path outside the root", () => {
    expect(fixtureEscapesRoot(outside, root).escapes).toBe(true);
  });

  it("flags a missing ../ path", () => {
    expect(fixtureEscapesRoot("../nope.txt", root).escapes).toBe(true);
  });

  it("does not flag a missing path inside the root", () => {
    expect(fixtureEscapesRoot("fixtures/missing.pdf", root).escapes).toBe(false);
  });

  it("flags an inside symlink that points outside", async () => {
    await symlink(outside, join(root, "fixtures", "link.txt"));
    expect(fixtureEscapesRoot("fixtures/link.txt", root).escapes).toBe(true);
  });
});
