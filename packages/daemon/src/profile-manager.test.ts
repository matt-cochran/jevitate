import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "./profile-manager.js";

test("create then status reports the profile exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-prof-"));
  const pm = new ProfileManager(root);
  expect((await pm.status("main")).exists).toBe(false);
  const created = await pm.create("main");
  expect(created.exists).toBe(true);
  expect(created.dir).toBe(join(root, "main"));
  expect((await pm.status("main")).exists).toBe(true);
});
