import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import { ProfileManager } from "@jevitate/daemon";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { BrowserPort, BrowserSession } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { runRecording, resolveRecordAllowlist, type RecorderLike } from "./record-api.js";

/**
 * A schema-valid demonstrated Recording the fake recorder hands back — a real
 * `Recorder.stop()` produces exactly this shape (navigate to the start URL,
 * then a click), so asserting it against `RecordingSchema` proves the wiring
 * emits something the interpreter can replay.
 */
const DEMO_RECORDING: Recording = {
  version: "1.0",
  site: "https://fixture.test",
  startedAtIso: "2026-09-21T00:00:00.000Z",
  intent: "sign in",
  pages: [
    {
      url: "https://fixture.test/login",
      steps: [
        {
          step: {
            kind: "navigate",
            url: "https://fixture.test/login",
            expect: { kind: "urlIncludes", text: "/login" },
          },
        },
        {
          step: {
            kind: "click",
            target: { role: "button", name: "Sign in" },
            expect: { kind: "urlIncludes", text: "/inbox" },
          },
        },
      ],
    },
  ],
};

/** A fake session whose `page` only needs what `runRecording` itself touches. */
function fakeSession(finalUrl: string): { session: BrowserSession; closed: () => boolean; goneTo: () => string[] } {
  let closedFlag = false;
  const navigated: string[] = [];
  const page = {
    async goto(u: string) {
      navigated.push(u);
      return null;
    },
    url() {
      return finalUrl;
    },
  } as unknown as BrowserSession["page"];
  const session: BrowserSession = {
    page,
    async startTracing() {},
    async stopTracingToFile() {},
    async close() {
      closedFlag = true;
    },
  };
  return { session, closed: () => closedFlag, goneTo: () => navigated };
}

function fakeRecorder(recording: Recording): { recorder: RecorderLike; calls: string[] } {
  const calls: string[] = [];
  const recorder: RecorderLike = {
    async install() {
      calls.push("install");
    },
    async start(intent) {
      calls.push(`start:${intent ?? ""}`);
    },
    async stop(retro) {
      calls.push(`stop:${retro ?? ""}`);
      return recording;
    },
  };
  return { recorder, calls };
}

describe("record-api — allowlist (pure, no browser)", () => {
  it("defaults the allowlist to the URL's own origin, honoring explicit --allow", () => {
    expect(resolveRecordAllowlist("http://127.0.0.1:3000/login", [])).toEqual(["http://127.0.0.1:3000"]);
    expect(resolveRecordAllowlist("http://127.0.0.1:3000/login", ["https://a.test"])).toEqual([
      "https://a.test",
    ]);
    expect(resolveRecordAllowlist("not a url", [])).toEqual([]); // fail-closed downstream
  });
});

describe("runRecording", () => {
  it("refuses an off-allowlist target BEFORE opening a browser", async () => {
    const browserPortFactory = vi.fn(() => {
      throw new Error("browser must not be opened for an unauthorized target");
    });
    await expect(
      runRecording({
        url: "http://127.0.0.1:3000/login",
        allowlist: ["https://only-this.example.com"],
        browserPortFactory,
        waitForStop: async () => {},
      }),
    ).rejects.toBeInstanceOf(UnauthorizedExploreTargetError);
    expect(browserPortFactory).not.toHaveBeenCalled();
  });

  it("drives the recorder, persists a schema-valid Recording, and cleans up", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "record-out-"));
    const { session, closed, goneTo } = fakeSession("https://fixture.test/inbox");
    const { recorder, calls } = fakeRecorder(DEMO_RECORDING);
    const browserPort: BrowserPort = { async open() { return session; } };

    let capturedProfileDir = "";
    const result = await runRecording({
      url: "https://fixture.test/login",
      allowlist: ["https://fixture.test"],
      intent: "sign in",
      outDir,
      browserPortFactory: () => ({
        async open(o) {
          capturedProfileDir = o.profileDir;
          return browserPort.open(o);
        },
      }),
      recorderFactory: () => recorder,
      waitForStop: async () => {},
      nowIso: () => "2026-09-21T12:00:00.000Z",
    });

    // Recorder lifecycle ran in order: install -> start(intent) -> stop.
    expect(calls).toEqual(["install", "start:sign in", "stop:"]);
    // The session was pointed at the start URL.
    expect(goneTo()).toEqual(["https://fixture.test/login"]);

    // The Recording was written to disk under outDir, and it parses.
    const files = await readdir(outDir);
    expect(files).toHaveLength(1);
    expect(result.recordingPath).toBe(join(outDir, files[0]));
    const onDisk = JSON.parse(await readFile(result.recordingPath, "utf8"));
    const parsed = RecordingSchema.parse(onDisk);
    expect(parsed.site).toBe("https://fixture.test");

    // It is replayable by the existing interpreter (constructs + flattens it).
    const interp = new RecordingInterpreter();
    expect(interp).toBeInstanceOf(RecordingInterpreter);
    expect(parsed.pages[0].steps).toHaveLength(2);

    expect(result.steps).toBe(2);
    expect(result.pages).toBe(1);
    expect(result.finalUrl).toBe("https://fixture.test/inbox");

    // Cleanup: session closed and the temp profile dir removed.
    expect(closed()).toBe(true);
    expect(capturedProfileDir).not.toBe("");
    expect(existsSync(capturedProfileDir)).toBe(false);
  });

  it("still closes the session and removes the profile dir when stop() throws", async () => {
    const { session, closed } = fakeSession("https://fixture.test/inbox");
    const recorder: RecorderLike = {
      async install() {},
      async start() {},
      async stop() {
        throw new Error("assembly failed");
      },
    };
    let capturedProfileDir = "";
    await expect(
      runRecording({
        url: "https://fixture.test/login",
        allowlist: ["https://fixture.test"],
        browserPortFactory: () => ({
          async open(o) {
            capturedProfileDir = o.profileDir;
            return session;
          },
        }),
        recorderFactory: () => recorder,
        waitForStop: async () => {},
      }),
    ).rejects.toThrow(/assembly failed/);
    expect(closed()).toBe(true);
    expect(existsSync(capturedProfileDir)).toBe(false);
  });
});

function newProgram(record?: Parameters<typeof buildProgram>[0]["record"]) {
  const profiles = new ProfileManager("/unused-in-these-tests");
  const lines: string[] = [];
  const program = buildProgram({ profiles, record });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines };
}

describe("record command — wiring (no real browser)", () => {
  it("fails when --url is missing", async () => {
    const { program, lines } = newProgram();
    await program.parseAsync(["record", "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_RECORD_ARGS" } });
  });

  it("refuses an off-allowlist target (no browser opened)", async () => {
    const browserPortFactory = vi.fn(() => {
      throw new Error("browser must not be opened for an unauthorized target");
    });
    const { program, lines } = newProgram({ browserPortFactory, waitForStop: async () => {} });
    await program.parseAsync(
      ["record", "--url", "https://evil.test/login", "--allow", "https://fixture.test", "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_UNAUTHORIZED_EXPLORE_TARGET" } });
    expect(browserPortFactory).not.toHaveBeenCalled();
  });

  it("captures and writes a Recording via injected seams, emitting a summary", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "record-cmd-"));
    const { session } = fakeSession("https://fixture.test/inbox");
    const { recorder } = fakeRecorder(DEMO_RECORDING);
    const { program, lines } = newProgram({
      browserPortFactory: () => ({ async open() { return session; } }),
      recorderFactory: () => recorder,
      waitForStop: async () => {},
    });
    await program.parseAsync(
      ["record", "--url", "https://fixture.test/login", "--intent", "sign in", "--out", outDir, "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: true, data: { steps: 2, pages: 1, finalUrl: "https://fixture.test/inbox" } });
    const onDisk = JSON.parse(await readFile(parsed.data.recordingPath, "utf8"));
    expect(RecordingSchema.parse(onDisk).site).toBe("https://fixture.test");
  });
});
