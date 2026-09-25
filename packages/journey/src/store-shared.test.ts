import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore } from "./store.js";
import { JourneyRegistry } from "./registry.js";

/**
 * Shared Journeys (0.2.0): a namespace folder under the Journeys dir — typically a git submodule
 * `journeys/<shared>/` shared by several app repos — is discovered like local Journeys, each under
 * `<namespace>/<id>`. Its files keep their own plain ids, so they stay portable across repos.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-shared-journeys-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const journey = (id: string, promoted: boolean) => ({
  metadata: { id, name: id, promoted, params: [], createdAtIso: "2026-09-25T00:00:00Z" },
  recording: { version: "1", site: "https://shop.example.test", pages: [] },
});

describe("shared Journeys in namespace folders", () => {
  it("lists, reads and promotes `<namespace>/<id>`; the file keeps its plain id", async () => {
    mkdirSync(join(dir, "commerce"));
    writeFileSync(join(dir, "commerce", "checkout.json"), JSON.stringify(journey("checkout", false)));
    writeFileSync(join(dir, "commerce", "README.md"), "shared Journeys");
    writeFileSync(join(dir, "commerce", ".git"), "gitdir: ../../.git/modules/commerce"); // a submodule's .git file
    const store = new FsJourneyStore(dir);
    await store.put(journey("login", true) as never);
    const reg = new JourneyRegistry(store);

    expect((await store.list()).map((m) => m.id).sort()).toEqual(["commerce/checkout", "login"]);
    expect((await store.get("commerce/checkout"))?.metadata.id).toBe("commerce/checkout");
    expect((await reg.find("")).map((m) => m.id)).toEqual(["login"]); // promoted only

    await reg.promote("commerce/checkout");
    expect((await reg.find("checkout")).map((m) => m.id)).toEqual(["commerce/checkout"]);
    expect(JSON.parse(readFileSync(join(dir, "commerce", "checkout.json"), "utf8")).metadata).toMatchObject({ id: "checkout", promoted: true });
  });

  it.each(["../escape", "a/b/c", "commerce/..", ".git/config", "a\\\\b", "/abs", "commerce/"])("refuses the unsafe id %j", async (id) => {
    const store = new FsJourneyStore(dir);
    await expect(store.get(id)).rejects.toThrow(/Invalid journey id/);
  });
});
