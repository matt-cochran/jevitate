import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "./profile-manager.js";

test("create then status reports the profile exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevitate-prof-"));
  const pm = new ProfileManager(root);
  expect((await pm.status("main")).exists).toBe(false);
  const created = await pm.create("main");
  expect(created.exists).toBe(true);
  expect(created.dir).toBe(join(root, "main"));
  expect((await pm.status("main")).exists).toBe(true);
});

// #221: profiles hold browser sessions — a crafted name must never create or probe a dir outside the root.
test.each(["../x", "a/../../x", "/tmp/jev-221-abs", "..\\x", "..", "x\u0000y"])("create/status refuse the traversal name %j and write nothing", async (name) => {
  const parent = await mkdtemp(join(tmpdir(), "jevitate-prof-221-"));
  const root = join(parent, "profiles");
  const pm = new ProfileManager(root);
  await expect(pm.create(name)).rejects.toMatchObject({ code: "E_INVALID_NAME" });
  await expect(pm.status(name)).rejects.toMatchObject({ code: "E_INVALID_NAME" });
  expect(existsSync(join(parent, "x"))).toBe(false);
  expect(existsSync("/tmp/jev-221-abs")).toBe(false);
  expect(existsSync(root)).toBe(false);
});
