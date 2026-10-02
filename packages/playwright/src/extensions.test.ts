import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExtensionDirError,
  describeExtensions,
  extensionIdForKey,
  extensionIdForPath,
  extensionLaunchArgs,
  readUnpackedExtension,
  readUnpackedExtensions,
  sameExtensionBuild,
} from "./extensions.js";

/** #256: unpacked extension directories are read, checked and identified before any browser opens. */

const FIXTURE_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "extension-mv3");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "jev-ext-unit-"));
}

describe("readUnpackedExtension", () => {
  it("reads the fixture's manifest and derives Chromium's id from its real path", () => {
    const ext = readUnpackedExtension(FIXTURE_EXTENSION);
    expect(ext).toMatchObject({ name: "Jevitate Fixture Extension", version: "1.2.3", manifestVersion: 3 });
    expect(ext.id).toMatch(/^[a-p]{32}$/);
    expect(ext.id).toBe(extensionIdForPath(ext.dir));
  });

  it("matches Chromium's id algorithm (sha256 of the path, first 32 hex digits mapped to a-p)", () => {
    // Observed from Chromium for an unpacked load of this exact path.
    expect(extensionIdForPath("/tmp/claude-1000/-home-mc-working-jevitate/ec54f5c3-7a14-492d-8e0c-1b2230a99506/scratchpad/spike/ext", "linux")).toBe(
      "kppeopockgllidioapmbgnipplfeaffl",
    );
  });

  it("on Windows hashes the UTF-16LE path with the drive letter upper-cased (Chromium's GenerateIdForPath)", () => {
    // sha256(UTF-16LE "C:\\foo") — the wchar_t bytes of the base::FilePath, not its UTF-8.
    expect(extensionIdForPath("C:\\foo", "win32")).toBe("jcmdbpboelcpjmighalofidgocgojlkg");
    expect(extensionIdForPath("c:\\foo", "win32")).toBe(extensionIdForPath("C:\\foo", "win32"));
    // The same characters as UTF-8 (the POSIX rule) give a different id.
    expect(extensionIdForPath("C:\\foo", "linux")).not.toBe(extensionIdForPath("C:\\foo", "win32"));
    // The windows-latest runner's fixture path (UTF-8 would give cmobedim…, which Chromium refused);
    // extensions-served.test.ts checks this id against the service worker Chromium actually started.
    expect(extensionIdForPath("D:\\a\\jevitate\\jevitate\\packages\\playwright\\test-fixtures\\extension-mv3", "win32")).toBe("paghcaihebkgicenbhojoaokfecipcpd");
  });

  it("a manifest `key` pins the id independent of the directory", () => {
    const a = scratch();
    const b = scratch();
    try {
      const key = Buffer.from("not-really-a-der-key").toString("base64");
      for (const d of [a, b]) writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "K", version: "1", key }));
      expect(readUnpackedExtension(a).id).toBe(extensionIdForKey(key));
      expect(readUnpackedExtension(b).id).toBe(readUnpackedExtension(a).id);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("resolves a relative directory and follows symlinks (Chromium is given the real path)", () => {
    const d = scratch();
    try {
      const link = join(d, "link");
      symlinkSync(FIXTURE_EXTENSION, link);
      expect(readUnpackedExtension("link", d).dir).toBe(readUnpackedExtension(FIXTURE_EXTENSION).dir);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it.each([
    ["a missing directory", (d: string) => join(d, "nope"), /extension directory not found/],
    ["a file, not a directory", (d: string) => (writeFileSync(join(d, "f.txt"), "x"), join(d, "f.txt")), /got a file/],
    ["a directory without manifest.json", (d: string) => (mkdirSync(join(d, "empty")), join(d, "empty")), /no manifest.json/],
    ["an unparseable manifest", (d: string) => (writeFileSync(join(d, "manifest.json"), "{nope"), d), /not valid JSON/],
    ["a manifest that is not an object", (d: string) => (writeFileSync(join(d, "manifest.json"), "[]"), d), /not a JSON object/],
    ["a bad manifest_version", (d: string) => (writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 4, name: "x", version: "1" })), d), /manifest_version/],
    ["a missing name", (d: string) => (writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "1" })), d), /"name"/],
    ["a missing version", (d: string) => (writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x" })), d), /"version"/],
  ])("refuses %s", (_what, make, message) => {
    const d = scratch();
    try {
      const target = make(d);
      expect(() => readUnpackedExtension(target)).toThrow(ExtensionDirError);
      expect(() => readUnpackedExtension(target)).toThrow(message);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses an empty path", () => {
    expect(() => readUnpackedExtension("  ")).toThrow(ExtensionDirError);
  });
});

describe("several extensions", () => {
  it("the same directory twice is loaded once; two directories with one id are refused", () => {
    expect(readUnpackedExtensions([FIXTURE_EXTENSION, FIXTURE_EXTENSION])).toHaveLength(1);
    const a = scratch();
    const b = scratch();
    try {
      const key = Buffer.from("same-key").toString("base64");
      for (const d of [a, b]) writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "K", version: "1", key }));
      expect(() => readUnpackedExtensions([a, b])).toThrow(/same extension id/);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("launch args load exactly the given directories", () => {
    const ext = readUnpackedExtension(FIXTURE_EXTENSION);
    expect(extensionLaunchArgs([ext])).toEqual([`--disable-extensions-except=${ext.dir}`, `--load-extension=${ext.dir}`]);
    expect(extensionLaunchArgs([])).toEqual([]);
  });
});

describe("sameExtensionBuild", () => {
  const a = { id: "a".repeat(32), name: "A", version: "1.0" };
  const b = { id: "b".repeat(32), name: "B", version: "2.0" };
  it("is order-insensitive and compares id, name and version", () => {
    expect(sameExtensionBuild([a, b], [b, a])).toBe(true);
    expect(sameExtensionBuild([a], [{ ...a, version: "1.1" }])).toBe(false);
    expect(sameExtensionBuild([a], [{ ...a, id: "c".repeat(32) }])).toBe(false);
    expect(sameExtensionBuild([a], undefined)).toBe(false);
    expect(sameExtensionBuild(undefined, [])).toBe(true);
  });
  it("describes a set for messages", () => {
    expect(describeExtensions([a])).toBe(`A@1.0 (${a.id})`);
    expect(describeExtensions(undefined)).toBe("none");
  });
});
