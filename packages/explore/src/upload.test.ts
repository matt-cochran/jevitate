import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Step } from "@jevitate/recording";
import {
  act,
  explore,
  FixtureNotFoundError,
  resolveMissionFixture,
  snapshot,
  UPLOAD_OP_GUIDE,
  type Control,
} from "./index.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * The `upload` op end to end against a REAL Chromium: a trivial served page
 * whose `<input type=file>` is visually hidden behind a styled label (the
 * common dropzone pattern). Preflight gate G2.
 */

const UPLOAD_PAGE = `<!doctype html><html><body>
  <h1>Profile</h1>
  <label for="avatar" style="display:inline-block;padding:2em;border:2px dashed #888">Choose avatar</label>
  <input id="avatar" type="file" accept="image/png,.txt" style="position:absolute;width:0;height:0;opacity:0" />
  <label for="identity" style="display:inline-block;padding:2em;border:2px dashed #888">Choose identity document</label>
  <input id="identity" type="file" accept="image/png,.txt" style="position:absolute;width:0;height:0;opacity:0" />
  <input id="nick" aria-label="Nickname" />
  <button type="button" style="display:none">Hidden button</button>
  <p id="status">nothing attached</p>
  <script>
    document.getElementById("avatar").addEventListener("change", (e) => {
      document.getElementById("status").textContent = "attached " + e.target.files[0].name;
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;
let fixtureDir: string;
let fixture: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(UPLOAD_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "jevitate-upload-fixture-")));
  fixture = join(fixtureDir, "avatar.txt");
  await writeFile(fixture, "fixture bytes\n", "utf8");
  await mkdir(join(fixtureDir, "proj"));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await rm(fixtureDir, { recursive: true, force: true });
});

function fileInputOf(controls: readonly Control[]): Control {
  const c = controls.find((x) => x.role === "file-input");
  if (c === undefined) throw new Error(`no file-input control in ${JSON.stringify(controls.map((x) => x.summary))}`);
  return c;
}

const readAttachedName = (s: { page: { evaluate: <R>(fn: () => R) => Promise<R> } }): Promise<string | null> =>
  s.page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#avatar");
    return input?.files?.[0]?.name ?? null;
  });

const readAttachedNames = (s: { page: { evaluate: <R>(fn: () => R) => Promise<R> } }): Promise<{ readonly avatar: string | null; readonly identity: string | null }> =>
  s.page.evaluate(() => ({
    avatar: document.querySelector<HTMLInputElement>("#avatar")?.files?.[0]?.name ?? null,
    identity: document.querySelector<HTMLInputElement>("#identity")?.files?.[0]?.name ?? null,
  }));

describe("snapshot — hidden file inputs are targetable, nothing else hidden is", () => {
  it(
    "surfaces the visually-hidden <input type=file> as role file-input with its label and accept filter",
    async () => {
      await withSession(
        "explore-upload-snap-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const snap = await snapshot(session.page);
          const file = fileInputOf(snap.controls);
          expect(file.inputType).toBe("file");
          expect(file.summary).toBe('file-input "Choose avatar" (accept=image/png,.txt)');
          // The display:none button stays hidden from the model.
          expect(snap.controls.map((c) => c.name)).not.toContain("Hidden button");
          expect(snap.controls.map((c) => c.role).sort()).toEqual(["file-input", "file-input", "textbox"]);
        },
        origin,
      );
    },
    120_000,
  );
});

describe("act — upload (G2)", () => {
  it(
    "attaches the mission fixture to a visually-hidden file input",
    async () => {
      await withSession(
        "explore-upload-act-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const control = fileInputOf((await snapshot(session.page)).controls);

          const r = await act(actor, { op: "upload", control, fixture, fixtureRoot: fixtureDir });

          expect(r).toEqual({ ok: true, mutated: true });
          expect(await readAttachedName(session)).toBe(basename(fixture));
          expect(await session.page.locator("#status").textContent()).toBe("attached avatar.txt");
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "fails closed with no target",
    async () => {
      await withSession(
        "explore-upload-notarget-",
        async (session) => {
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const r = await act(actor, { op: "upload", control: null, fixture, fixtureRoot: fixtureDir });
          expect(r).toEqual({ ok: false, mutated: false, reason: "upload needs a target" });
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "fails closed with no mission fixture (the model never supplies a path) and attaches nothing",
    async () => {
      await withSession(
        "explore-upload-nofixture-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const control = fileInputOf((await snapshot(session.page)).controls);
          for (const missing of [undefined, null]) {
            const r = await act(actor, { op: "upload", control, fixture: missing, fixtureRoot: fixtureDir });
            expect(r).toEqual({ ok: false, mutated: false, reason: "upload has no mission fixture (fail-closed)" });
          }
          expect(await readAttachedName(session)).toBeNull();
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "fails closed on a target that is not an <input type=file> — never guesses another element",
    async () => {
      await withSession(
        "explore-upload-notfile-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const nick = (await snapshot(session.page)).controls.find((c) => c.name === "Nickname");
          if (nick === undefined) throw new Error("Nickname control not surfaced");

          const r = await act(actor, { op: "upload", control: nick, fixture, fixtureRoot: fixtureDir });

          expect(r.ok).toBe(false);
          expect(r.mutated).toBe(false);
          expect(r.reason).toMatch(/^no <input type=file> for target /);
          expect(r.reason).toContain("Nickname");
          // The real file input next to it was NOT used as a fallback.
          expect(await readAttachedName(session)).toBeNull();
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "fails closed on a disabled file input",
    async () => {
      await withSession(
        "explore-upload-disabled-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const control = fileInputOf((await snapshot(session.page)).controls);
          await session.page.evaluate(() => {
            document.querySelector<HTMLInputElement>("#avatar")!.disabled = true;
          });
          const r = await act(actor, { op: "upload", control, fixture, fixtureRoot: fixtureDir });
          expect(r).toEqual({ ok: false, mutated: false, reason: "target not enabled" });
        },
        origin,
      );
    },
    120_000,
  );
});

describe("act — upload #498: the mission fixture must be inside the project root", () => {
  it(
    "refuses a fixture outside the root and attaches nothing",
    async () => {
      await withSession(
        "explore-upload-outside-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const control = fileInputOf((await snapshot(session.page)).controls);
          await act(actor, { op: "upload", control, fixture, fixtureRoot: join(fixtureDir, "proj") });
          expect(await readAttachedName(session)).toBeNull();
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "refuses a symlink inside the root that points outside, naming the root and the fix",
    async () => {
      await withSession(
        "explore-upload-symlink-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const control = fileInputOf((await snapshot(session.page)).controls);
          const root = join(fixtureDir, "proj");
          await symlink(fixture, join(root, "link.txt"));
          const r = await act(actor, { op: "upload", control, fixture: join(root, "link.txt"), fixtureRoot: root });
          expect(r.reason).toContain(`is outside the project root ${root} — move the fixture into the project`);
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "refuses an upload with no project root (fail-closed)",
    async () => {
      await withSession(
        "explore-upload-noroot-",
        async (session) => {
          await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const control = fileInputOf((await snapshot(session.page)).controls);
          const r = await act(actor, { op: "upload", control, fixture });
          expect(r).toMatchObject({ ok: false, mutated: false });
        },
        origin,
      );
    },
    120_000,
  );
});

describe("#498 resolveMissionFixture with the project root", () => {
  it("refuses a mission fixture outside the root before the mission starts", async () => {
    await expect(resolveMissionFixture(fixture, join(fixtureDir, "proj"))).rejects.toThrow("outside the project root");
  });

  it("accepts a mission fixture inside the root", async () => {
    expect(await resolveMissionFixture(fixture, fixtureDir)).toBe(fixture);
  });
});

describe("mission fixture validation (fail fast at mission start)", () => {
  it("resolveMissionFixture returns the absolute path of an existing file", async () => {
    expect(await resolveMissionFixture(fixture)).toBe(fixture);
  });

  it("rejects a missing path and a directory with `fixture not found: <path>`", async () => {
    const missing = join(fixtureDir, "nope.txt");
    await expect(resolveMissionFixture(missing)).rejects.toThrow(new FixtureNotFoundError(missing).message);
    await expect(resolveMissionFixture(missing)).rejects.toBeInstanceOf(FixtureNotFoundError);
    await expect(resolveMissionFixture(fixtureDir)).rejects.toThrow(`fixture not found: ${fixtureDir}`);
  });

  it(
    "explore() refuses a missing fixture before navigating or asking the model anything",
    async () => {
      await withSession(
        "explore-upload-missing-",
        async (session) => {
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const judge = new ScriptedJudge([{ op: "done" }]);
          const missing = join(fixtureDir, "missing.png");
          await expect(
            explore({
              actor,
              judge,
              gen: new FakeGenerationGateway(),
              goal: "attach an avatar",
              allowlist: [origin],
              startUrl: `${origin}/`,
              fixture: missing,
              fixtureRoot: fixtureDir,
            }),
          ).rejects.toThrow(`fixture not found: ${missing}`);
          expect(judge.states).toHaveLength(0);
          expect(session.page.url()).toBe("about:blank");
        },
        origin,
      );
    },
    120_000,
  );
});

describe("explore loop — upload is recorded and replays deterministically", () => {
  it(
    "offers upload only with a fixture, records it, and the Recording re-attaches the same file on replay",
    async () => {
      const judge = new ScriptedJudge([{ op: "upload", target: "0" }, { op: "done" }]);
      const run = await withSession(
        "explore-upload-loop-",
        async (session) => {
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const r = await explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "attach an avatar",
            allowlist: [origin],
            startUrl: `${origin}/`,
            fixture,
            fixtureRoot: fixtureDir,
          });
          expect(await readAttachedName(session)).toBe("avatar.txt");
          return r;
        },
        origin,
      );

      expect(run.stop).toBe("done");
      expect(run.actions).toBe(1);
      expect(judge.actionOptions[0]?.some((o) => o.startsWith("upload:"))).toBe(true);
      // One fixture ⇒ one upload: once attached, no upload action (nor its guide) is offered again.
      expect(judge.actionOptions[1]?.some((o) => o.startsWith("upload"))).toBe(false);
      expect(judge.states[1]?.controls).not.toContain(UPLOAD_OP_GUIDE);
      const steps: Step[] = run.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
      const upload = steps.find((s) => s.kind === "upload");
      expect(upload).toMatchObject({ kind: "upload", file: { redacted: false, value: "avatar.txt" } });

      await withSession(
        "explore-upload-replay-",
        async (fresh) => {
          const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [origin]));
          const result = await new RecordingInterpreter({ fixtureBaseDir: fixtureDir }).run(actor, run.recording);
          expect(result.outcome).toBe("completed");
          expect(await readAttachedName(fresh)).toBe("avatar.txt");
        },
        origin,
      );

      // Replay fails fast — naming the path — once the recorded fixture is gone,
      // never attaching some other file.
      const gone = join(fixtureDir, "deleted.txt");
      const pointingAtGone = JSON.parse(JSON.stringify(run.recording).split(JSON.stringify("avatar.txt")).join(JSON.stringify("deleted.txt")));
      await withSession(
        "explore-upload-replay-gone-",
        async (fresh) => {
          const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [origin]));
          const result = await new RecordingInterpreter({ fixtureBaseDir: fixtureDir }).run(actor, pointingAtGone);
          expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining(`fixture not found: ${gone}`) });
          expect(await readAttachedName(fresh)).toBeNull();
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "uses the selected control's descriptor-bound fixture ahead of the generic fallback and records no absolute path",
    async () => {
      const bound = join(fixtureDir, "bound-avatar.txt");
      await writeFile(bound, "bound fixture bytes\n", "utf8");
      const judge = new ScriptedJudge([{ op: "upload", target: "0" }, { op: "done" }]);
      const run = await withSession(
        "explore-upload-bound-",
        async (session) => {
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const r = await explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "attach an avatar",
            allowlist: [origin],
            startUrl: `${origin}/`,
            fixture,
            fixtureRoot: fixtureDir,
            uploadFixtures: [{ descriptor: "label=Choose avatar", matcher: { key: "label", value: "Choose avatar" }, name: "bound-avatar.txt", path: bound }],
          });
          expect(await readAttachedName(session)).toBe("bound-avatar.txt");
          return r;
        },
        origin,
      );
      const upload = run.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).find((s) => s.kind === "upload");
      expect(upload).toMatchObject({ file: { redacted: false, value: "bound-avatar.txt" } });
      expect(JSON.stringify(judge.states)).toContain("«fixture:bound-avatar.txt»");
      expect(JSON.stringify(judge.states)).not.toContain(bound);
    },
    120_000,
  );

  it(
    "never offers upload to the model when the mission has no fixture",
    async () => {
      const judge = new ScriptedJudge([{ op: "done" }]);
      await withSession(
        "explore-upload-nooffer-",
        async (session) => {
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          await explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "look around",
            allowlist: [origin],
            startUrl: `${origin}/`,
          });
        },
        origin,
      );
      expect(judge.actionOptions[0]?.some((o) => o.startsWith("upload"))).toBe(false);
      expect(judge.states[0]?.controls.join("\n")).not.toContain("OP upload");
    },
    120_000,
  );

  it(
    "offers and attaches each descriptor-bound fixture without a generic fallback",
    async () => {
      const avatar = join(fixtureDir, "bound-avatar-only.txt");
      const identity = join(fixtureDir, "bound-identity-only.txt");
      await writeFile(avatar, "avatar fixture bytes\n", "utf8");
      await writeFile(identity, "identity fixture bytes\n", "utf8");
      const judge = new ScriptedJudge([{ op: "upload", target: "0" }, { op: "upload", target: "1" }, { op: "done" }]);
      const run = await withSession(
        "explore-upload-two-bound-",
        async (session) => {
          const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
          const result = await explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "attach avatar and identity document",
            allowlist: [origin],
            startUrl: `${origin}/`,
            fixtureRoot: fixtureDir,
            uploadFixtures: [
              { descriptor: "label=Choose avatar", matcher: { key: "label", value: "Choose avatar" }, name: "bound-avatar-only.txt", path: avatar },
              { descriptor: "label=Choose identity document", matcher: { key: "label", value: "Choose identity document" }, name: "bound-identity-only.txt", path: identity },
            ],
          });
          expect(await readAttachedNames(session)).toEqual({ avatar: "bound-avatar-only.txt", identity: "bound-identity-only.txt" });
          return result;
        },
        origin,
      );
      expect(run.stop).toBe("done");
      expect(run.actions).toBe(2);
      expect(judge.actionOptions[0]?.some((option) => option.startsWith("upload:"))).toBe(true);
      expect(judge.actionOptions[1]?.some((option) => option.startsWith("upload:"))).toBe(true);
      const uploads = run.recording.pages
        .flatMap((page) => page.steps.map((step) => step.step))
        .filter((step): step is Extract<Step, { kind: "upload" }> => step.kind === "upload")
        .map((step) => step.file);
      expect(uploads).toEqual([
        { redacted: false, value: "bound-avatar-only.txt" },
        { redacted: false, value: "bound-identity-only.txt" },
      ]);
    },
    120_000,
  );

  it(
    "a --secret inside the fixture path never reaches the Recording (or the model) on an upload run",
    async () => {
      const SECRET = "TOPSECRET42";
      const secretDir = await realpath(await mkdtemp(join(tmpdir(), "jevitate-upload-secret-")));
      const secretFixture = join(secretDir, `avatar-${SECRET}.txt`);
      await writeFile(secretFixture, "fixture bytes\n", "utf8");
      try {
        const judge = new ScriptedJudge([{ op: "upload", target: "0" }, { op: "done" }]);
        const run = await withSession(
          "explore-upload-secretrun-",
          async (session) => {
            const actor = CastActor.named("upload").whoCan(new BrowseTheWeb(session, [origin]));
            const r = await explore({
              actor,
              judge,
              gen: new FakeGenerationGateway(),
              goal: "attach an avatar",
              allowlist: [origin],
              startUrl: `${origin}/`,
              fixture: secretFixture,
              fixtureRoot: secretDir,
              secrets: [SECRET],
            });
            // The real file WAS attached — redaction only affects what is persisted.
            expect(await readAttachedName(session)).toBe(`avatar-${SECRET}.txt`);
            return r;
          },
          origin,
        );

        const steps: Step[] = run.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
        expect(steps.some((s) => s.kind === "upload")).toBe(true);
        const upload = steps.find((s) => s.kind === "upload");
        expect(upload).toMatchObject({ file: { redacted: true, length: secretFixture.length } });
        expect(JSON.stringify(run.recording)).not.toContain(SECRET);
        expect(JSON.stringify(run.transcript)).not.toContain(SECRET);
        expect(JSON.stringify(judge.states)).not.toContain(SECRET);
      } finally {
        await rm(secretDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
