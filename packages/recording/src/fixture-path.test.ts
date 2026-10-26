import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FixturePathError, confineFixture, fixtureEscapesRoot, fixtureRootRefusal, fixtureSensitiveReason } from "./fixture-path.js";

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

  it("refuses an absolute path inside the root", async () => {
    expect(await codeOf(confineFixture(join(root, "fixtures", "receipt.pdf"), root))).toBe("fixture-outside-project");
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
    await expect(confineFixture(outside, root)).rejects.toThrow(`upload fixture ${outside} must be project-relative to ${root} — rewrite it as a path inside the project`);
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

// 0.12.0 review H1: a root that is the filesystem root, the home folder or ~/.jevitate confines nothing.
describe("#498 confineFixture refuses a root that confines nothing", () => {
  it("refuses the filesystem root", async () => {
    expect(await codeOf(confineFixture("etc/hostname", "/"))).toBe("fixture-no-root");
  });

  it("refuses the home directory", async () => {
    expect(await codeOf(confineFixture(".ssh/id_ed25519", homedir()))).toBe("fixture-no-root");
  });

  it("refuses jevitate's home data folder", async () => {
    expect(await codeOf(confineFixture("credentials.json", join(homedir(), ".jevitate")))).toBe("fixture-no-root");
  });

  it("names the refused root in the message", async () => {
    await expect(confineFixture("etc/hostname", "/")).rejects.toThrow("/ is not a project root (the filesystem root)");
  });
});

describe("#498 fixtureRootRefusal", () => {
  it("allows an ordinary project folder", () => {
    expect(fixtureRootRefusal(root)).toBeNull();
  });

  it("refuses the home directory", () => {
    expect(fixtureRootRefusal(homedir())).toBe("your home directory");
  });
});

// 0.12.0 review M2: a sensitive file inside the root is refused (fixture-sensitive).
describe("#498 confineFixture refuses a sensitive file inside the root", () => {
  async function put(rel: string): Promise<void> {
    const file = join(root, rel);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "x");
  }

  it.each([
    [".env"],
    [".env.local"],
    [".git/config"],
    [".jevitate/credentials.json"],
    ["certs/server.pem"],
    ["certs/server.key"],
    ["certs/client.p12"],
    ["certs/client.pfx"],
    ["captures/run.har"],
    ["logs/2026-10-11/trace.zip"],
    ["auth/storage-state.json"],
    ["auth/admin.storageState.json"],
    ["keys/id_rsa"],
    ["keys/id_ed25519.pub"],
    ["keys/id_ecdsa"],
  ])("refuses %s", async (rel) => {
    await put(rel);
    expect(await codeOf(confineFixture(rel, root))).toBe("fixture-sensitive");
  });

  it("refuses an innocent-looking symlink whose target is sensitive", async () => {
    await put(".env");
    await symlink(join(root, ".env"), join(root, "fixtures", "data.csv"));
    expect(await codeOf(confineFixture("fixtures/data.csv", root))).toBe("fixture-sensitive");
  });

  it.each([["fixtures/receipt.pdf"], ["fixtures/crm-import-journey-happy.csv"], ["fixtures/avatar.png"], ["fixtures/payload.json"]])("accepts ordinary fixture %s", async (rel) => {
    await put(rel);
    expect(await confineFixture(rel, root)).toBe(join(root, rel));
  });

  it("names the path, the reason and the fix in the message", async () => {
    await put(".env");
    await expect(confineFixture(".env", root)).rejects.toThrow(`upload fixture ${join(root, ".env")} looks sensitive (hidden path segment ".env") — use a dedicated test fixture file`);
  });
});

describe("#498 fixtureSensitiveReason (lint, sync)", () => {
  it("is null for an ordinary fixture", () => {
    expect(fixtureSensitiveReason(join(root, "fixtures", "receipt.pdf"), root)).toBeNull();
  });

  it("names a private key", () => {
    expect(fixtureSensitiveReason(join(root, "server.key"), root)).toBe("private key or certificate (.key)");
  });
});
