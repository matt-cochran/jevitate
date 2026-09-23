import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type Control,
  type Op,
} from "./index.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * The `upload` op end to end against a REAL Chromium: a trivial served page
 * whose `<input type=file>` is visually hidden behind a styled label (the
 * common dropzone pattern). Preflight gate G2.
 */

const UPLOAD_PAGE = `<!doctype html><html><body>
  <h1>Profile</h1>
  <label for="avatar" style="display:inline-block;padding:2em;border:2px dashed #888">Choose avatar</label>
  <input id="avatar" type="file" accept="image/png,.txt" style="position:absolute;width:0;height:0;opacity:0" />
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
  fixtureDir = await mkdtemp(join(tmpdir(), "jevitate-upload-fixture-"));
  fixture = join(fixtureDir, "avatar.txt");
  await writeFile(fixture, "fixture bytes\n", "utf8");
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
          expect(snap.controls.map((c) => c.role).sort()).toEqual(["file-input", "textbox"]);
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

          const r = await act(actor, { op: "upload", control, fixture });

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
          const r = await act(actor, { op: "upload", control: null, fixture });
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
            const r = await act(actor, { op: "upload", control, fixture: missing });
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

          const r = await act(actor, { op: "upload", control: nick, fixture });

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
          const r = await act(actor, { op: "upload", control, fixture });
          expect(r).toEqual({ ok: false, mutated: false, reason: "target not enabled" });
        },
        origin,
      );
    },
    120_000,
  );
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
          });
          expect(await readAttachedName(session)).toBe("avatar.txt");
          return r;
        },
        origin,
      );

      expect(run.stop).toBe("done");
      expect(run.actions).toBe(1);
      expect(judge.actionOptions[0]?.some((o) => o.startsWith("upload:"))).toBe(true);
      const steps: Step[] = run.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
      const upload = steps.find((s) => s.kind === "upload");
      expect(upload).toMatchObject({ kind: "upload", file: { redacted: false, value: fixture } });

      await withSession(
        "explore-upload-replay-",
        async (fresh) => {
          const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [origin]));
          const result = await new RecordingInterpreter().run(actor, run.recording);
          expect(result.outcome).toBe("completed");
          expect(await readAttachedName(fresh)).toBe("avatar.txt");
        },
        origin,
      );

      // Replay fails fast — naming the path — once the recorded fixture is gone,
      // never attaching some other file.
      const gone = join(fixtureDir, "deleted.txt");
      const pointingAtGone = JSON.parse(JSON.stringify(run.recording).split(JSON.stringify(fixture)).join(JSON.stringify(gone)));
      await withSession(
        "explore-upload-replay-gone-",
        async (fresh) => {
          const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [origin]));
          const result = await new RecordingInterpreter().run(actor, pointingAtGone);
          expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining(`fixture not found: ${gone}`) });
          expect(await readAttachedName(fresh)).toBeNull();
        },
        origin,
      );
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
    "a --secret inside the fixture path never reaches the Recording (or the model) on an upload run",
    async () => {
      const SECRET = "TOPSECRET42";
      const secretDir = await mkdtemp(join(tmpdir(), "jevitate-upload-secret-"));
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
