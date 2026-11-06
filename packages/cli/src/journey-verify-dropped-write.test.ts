import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { BrowserPort, BrowserSession } from "@jevitate/playwright";
import type { JourneyVerifySeams } from "./journey-cli/verify.js";
import { verifyCheckpointPath } from "./journey-verify-checkpoint.js";
import { JourneyVerifyStalledError, isolationReason, verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";

/**
 * A write open when a new document loads is gone with the old one, and the browser may report nothing
 * about it. It must read as aborted: left open, it would taint the proof as a replay that closed with a
 * write still unanswered. Which replays the browser stays silent on is a race, so this drives the probe
 * through the `run` seam with a double that is silent every time.
 */

type Run = NonNullable<JourneyVerifySeams["run"]>;
type RunResult = Awaited<ReturnType<Run>>;

const ID = "save";
const SAVE = "http://127.0.0.1:9/api/save";
const UNANSWERED = /closed with a write still unanswered/;
const passed = { outcome: "ok", output: {} } as RunResult;

const JOURNEY: Journey = {
  metadata: { id: ID, name: "Save", promoted: false, params: [], createdAtIso: "2026-11-05T00:00:00.000Z", mutationPairs: [{ check: "step:1", mustFailWhen: "skip:1" }] },
  recording: {
    version: "1",
    site: "http://127.0.0.1:9",
    pages: [
      {
        url: "/",
        steps: [
          {
            step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { testId: "status" } } },
            delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 },
          },
        ],
      },
    ],
  },
};

const request = (method: string, url: string, navigation = false): object => ({ method: () => method, url: () => url, isNavigationRequest: () => navigation });

interface Browser {
  readonly context: EventEmitter;
  readonly page: EventEmitter;
  /** What the browser itself reports: `Network.dataReceived` is the only word on a body the page does not read. */
  readonly cdp: EventEmitter;
}
/** The browser reports a write, as a page's CDP session does, under its own request id. */
const browserSent = ({ cdp }: Browser, requestId: string): void => void cdp.emit("Network.requestWillBeSent", { requestId, request: { method: "POST", url: SAVE } });
const browserAnswered = ({ cdp }: Browser, requestId: string, cacheControl = "no-store"): void => void cdp.emit("Network.responseReceived", { requestId, response: { headers: { "Cache-Control": cacheControl } } });
const bodyArrived = ({ cdp }: Browser, requestId: string): void => void cdp.emit("Network.dataReceived", { requestId });
const write = ({ context }: Browser): void => void context.emit("request", request("POST", SAVE));
const newDocument = ({ context, page }: Browser): void => {
  context.emit("request", request("GET", "http://127.0.0.1:9/", true));
  page.emit("domcontentloaded");
};

let dir: string;
let fake: FakeClock;
let hanging: "newCDPSession" | "enable" | undefined;
const progressPath = (): string => verifyCheckpointPath(join(dir, ".jevitate"), dir, ID);
const taintOnFile = (): unknown => (JSON.parse(readFileSync(progressPath(), "utf8")) as { body: { taint: unknown } }).body.taint;
const stalled = (sessionsClosed: boolean): JourneyVerifyStalledError => new JourneyVerifyStalledError({ replay: 3 }, 1, sessionsClosed);
const realTimer = setTimeout;

/** A proof whose first mutated replay does `during` on its browser, then closes it. */
async function proveWith(during: (browser: Browser) => void, thenThrow: boolean | Error = false, resume?: boolean, atReplay = 3): Promise<JourneyVerifyReport> {
  let replay = 0;
  let browser: Browser;
  const browserPortFactory = (): BrowserPort => ({
    open: async () => {
      const context = new EventEmitter();
      const never = new Promise<never>(() => undefined);
      const cdp = Object.assign(new EventEmitter(), { send: async () => (hanging === "enable" ? never : {}) });
      Object.assign(context, { newCDPSession: async () => (hanging === "newCDPSession" ? never : cdp) });
      const page = Object.assign(new EventEmitter(), { context: () => context });
      browser = { context, page, cdp };
      return { page, close: async () => undefined } as unknown as BrowserSession;
    },
  });
  const run = (async (options: Parameters<Run>[0]) => {
    replay += 1;
    const session = await options.browserPortFactory!().open({} as never);
    const actor = { ability: () => ({ session: { page: {} } }) };
    await options.observer?.beforeStep?.({ index: 0, actor } as never);
    // The base replay, then the independence replay, then the first mutated one.
    if (replay === atReplay) during(browser);
    await options.observer?.afterStep?.({ index: 0, actor, outcome: "done" } as never);
    const stalledOpen = thenThrow instanceof JourneyVerifyStalledError && !thenThrow.sessionsClosed && replay === 3;
    if (!stalledOpen) await session.close();
    if (thenThrow instanceof Error && replay === 3) throw thenThrow;
    if (thenThrow === true && replay === 3) throw new Error("Target page, context or browser has been closed");
    return passed;
  }) as unknown as Run;
  const checkpoint = resume === undefined ? {} : { checkpoint: { path: progressPath(), keyFile: join(dir, "k.key"), resume, build: { version: "t", commit: "c", builtAt: "b", tree: "tr" }, config: { hook: {}, origin: {}, browser: {} } } };
  const proving = verifyJourneyMutations({ dir, id: ID, params: {}, browserPortFactory, ...checkpoint }, run);
  let done = false;
  const ended = proving.finally(() => void (done = true));
  ended.catch(() => undefined);
  while (!done) {
    fake.runUntilIdle();
    await new Promise((resolve) => realTimer(resolve, 1));
  }
  return ended;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-dropped-write-"));
  await new FsJourneyStore(dir).put(JOURNEY);
  fake = new FakeClock();
  installClock(fake);
  hanging = undefined;
});

afterEach(() => {
  resetClock();
  rmSync(dir, { recursive: true, force: true });
});

describe("a write a new document dropped", () => {
  it("reads as aborted: the proof is not tainted by it", async () => {
    const report = await proveWith((b) => {
      write(b);
      newDocument(b);
    });
    expect(report.reason ?? "").not.toMatch(UNANSWERED);
    expect(report.verdict, report.reason).toBe("insensitive");
  });

  it("a write still open with no new document taints the proof", async () => {
    const report = await proveWith(write);
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toMatch(UNANSWERED);
  });

  /** A POST the server answered: its response, and the body the browser reports only once it has ended. */
  const answered = (b: Browser, id = "r1"): object => {
    const save = request("POST", SAVE);
    b.context.emit("request", save);
    browserSent(b, id);
    b.context.emit("response", { request: () => save });
    browserAnswered(b, id);
    bodyArrived(b, id);
    return save;
  };

  it("a write whose body arrived is answered, though the browser never says it finished", async () => {
    const report = await proveWith((b) => void answered(b));
    expect(report.reason ?? "").not.toMatch(UNANSWERED);
    expect(report.verdict, report.reason).toBe("insensitive");
  });

  it("the browser can report the body before Playwright reports the response", async () => {
    const report = await proveWith((b) => {
      const save = request("POST", SAVE);
      b.context.emit("request", save);
      browserSent(b, "r1");
      browserAnswered(b, "r1");
      bodyArrived(b, "r1");
      b.context.emit("response", { request: () => save });
    });
    expect(report.reason ?? "").not.toMatch(UNANSWERED);
    expect(report.verdict, report.reason).toBe("insensitive");
  });

  it("a response whose body has not arrived keeps the write open: the server may still be working", async () => {
    const report = await proveWith((b) => {
      const save = request("POST", SAVE);
      b.context.emit("request", save);
      browserSent(b, "r1");
      b.context.emit("response", { request: () => save });
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toMatch(UNANSWERED);
  });

  it.each(["", "no-cache", "max-age=60", "no-storey"])("a body reported under Cache-Control %j answers nothing: only a no-store body reports at its end", async (cacheControl) => {
    const report = await proveWith((b) => {
      const save = request("POST", SAVE);
      b.context.emit("request", save);
      browserSent(b, "r1");
      b.context.emit("response", { request: () => save });
      browserAnswered(b, "r1", cacheControl);
      bodyArrived(b, "r1");
    });
    expect(report.reason).toMatch(UNANSWERED);
  });

  it.each(["no-store", "private, no-store", "NO-STORE, max-age=0"])("a body reported under Cache-Control %j answers the write", async (cacheControl) => {
    const report = await proveWith((b) => {
      const save = request("POST", SAVE);
      b.context.emit("request", save);
      browserSent(b, "r1");
      b.context.emit("response", { request: () => save });
      browserAnswered(b, "r1", cacheControl);
      bodyArrived(b, "r1");
    });
    expect(report.reason ?? "").not.toMatch(UNANSWERED);
  });

  describe("a held write and a body on the same line that ends", () => {
    const held = (b: Browser): object => {
      const a = request("POST", SAVE);
      b.context.emit("request", a);
      browserSent(b, "a");
      b.context.emit("response", { request: () => a });
      browserAnswered(b, "a");
      const other = request("POST", SAVE);
      b.context.emit("request", other);
      browserSent(b, "b");
      b.context.emit("response", { request: () => other });
      browserAnswered(b, "b");
      return other;
    };

    it("the browser says the body ended after Playwright says the request finished: the held write is still open", async () => {
      const report = await proveWith((b) => {
        const other = held(b);
        b.context.emit("requestfinished", other);
        bodyArrived(b, "b");
        b.cdp.emit("Network.loadingFinished", { requestId: "b" });
      });
      expect(report.reason).toMatch(UNANSWERED);
    });

    it("the browser says the body ended before Playwright does: the held write is still open", async () => {
      const report = await proveWith((b) => {
        const other = held(b);
        bodyArrived(b, "b");
        b.cdp.emit("Network.loadingFinished", { requestId: "b" });
        b.context.emit("requestfinished", other);
      });
      expect(report.reason).toMatch(UNANSWERED);
    });
  });

  describe("attaching to the page's network events hangs", () => {
    const heldBy = (hang: (b: Browser) => void) => (b: Browser): void => {
      hang(b);
      const save = request("POST", SAVE);
      b.context.emit("request", save);
      b.context.emit("response", { request: () => save });
    };

    it("the replay carries on, and a write with no reported body reads as open", async () => {
      hanging = "newCDPSession";
      const report = await proveWith(heldBy(() => undefined));
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toMatch(UNANSWERED);
    });

    it("the same when Network.enable never answers", async () => {
      hanging = "enable";
      const report = await proveWith(heldBy(() => undefined));
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toMatch(UNANSWERED);
    });
  });

  it("with no CDP session nothing says a body arrived, so a response alone keeps the write open", async () => {
    const report = await proveWith((b) => {
      Object.assign(b.context, { newCDPSession: undefined });
      const save = request("POST", SAVE);
      b.context.emit("request", save);
      b.context.emit("response", { request: () => save });
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toMatch(UNANSWERED);
  });

  it("a read's response answers no write", async () => {
    const report = await proveWith((b) => {
      write(b);
      b.context.emit("response", { request: () => request("GET", SAVE) });
    });
    expect(report.reason).toMatch(UNANSWERED);
  });

  it("two writes on one line and one body: one is still open", async () => {
    const report = await proveWith((b) => {
      answered(b, "r1");
      const held = request("POST", SAVE);
      b.context.emit("request", held);
      browserSent(b, "r2");
      b.context.emit("response", { request: () => held });
      browserAnswered(b, "r2");
    });
    expect(report.reason).toMatch(UNANSWERED);
  });

  it("many reports of one body count once", async () => {
    const report = await proveWith((b) => {
      answered(b, "r1");
      bodyArrived(b, "r1");
      const held = request("POST", SAVE);
      b.context.emit("request", held);
      browserSent(b, "r2");
      b.context.emit("response", { request: () => held });
      browserAnswered(b, "r2");
    });
    expect(report.reason).toMatch(UNANSWERED);
  });

  it("a body that ended earlier says nothing about the next write on that line", async () => {
    const report = await proveWith((b) => {
      answered(b, "r1");
      newDocument(b);
      const held = request("POST", SAVE);
      b.context.emit("request", held);
      browserSent(b, "r2");
      b.context.emit("response", { request: () => held });
      browserAnswered(b, "r2");
    });
    expect(report.reason).toMatch(UNANSWERED);
  });

  it("a redirect that turns the write into a read leaves no body to claim", async () => {
    const report = await proveWith((b) => {
      browserSent(b, "r1");
      b.cdp.emit("Network.requestWillBeSent", { requestId: "r1", request: { method: "GET", url: "http://127.0.0.1:9/after" } });
      bodyArrived(b, "r1");
      const held = request("POST", SAVE);
      b.context.emit("request", held);
      browserSent(b, "r2");
      b.context.emit("response", { request: () => held });
      browserAnswered(b, "r2");
    });
    expect(report.reason).toMatch(UNANSWERED);
  });

  it("a request failing after its response is no abort: it was answered", async () => {
    const report = await proveWith(({ context }) => {
      const save = Object.assign(request("POST", SAVE), { failure: () => ({ errorText: "net::ERR_ABORTED" }) });
      context.emit("request", save);
      context.emit("response", { request: () => save });
      context.emit("requestfailed", save);
    });
    expect(report.reason ?? "").not.toMatch(UNANSWERED);
    expect(report.verdict, report.reason).toBe("insensitive");
  });

  it("the same write answered later counts once, however its body ends", async () => {
    const report = await proveWith(({ context }) => {
      const save = request("POST", SAVE);
      context.emit("request", save);
      context.emit("response", { request: () => save });
      context.emit("requestfinished", save);
    });
    expect(report.verdict, report.reason).toBe("insensitive");
  });

  describe("the 2 s a replay stays open", () => {
    /** How long the first mutated replay stayed open after `during`, up to its close. */
    const heldOpenMs = async (during: (b: Browser) => void): Promise<number> => {
      let doneAt = 0;
      let closedAt = 0;
      const browserClosed = (b: Browser): void => {
        during(b);
        doneAt = fake.monotonicMs();
        const beforeClose = (b.page as unknown as { evaluate?: unknown }).evaluate;
        Object.assign(b.page, { evaluate: async () => { closedAt = fake.monotonicMs(); return beforeClose; } });
      };
      await proveWith(browserClosed);
      return closedAt - doneAt;
    };
    const abort = { failure: () => ({ errorText: "net::ERR_ABORTED" }) };

    it("after a write the browser gave up on", async () => {
      expect(await heldOpenMs(({ context }) => {
        const save = Object.assign(request("POST", SAVE), abort);
        context.emit("request", save);
        context.emit("requestfailed", save);
      })).toBeGreaterThanOrEqual(2_000);
    });

    it("after a write answered, then aborted: the server may still be working", async () => {
      expect(await heldOpenMs(({ context }) => {
        const save = Object.assign(request("POST", SAVE), abort);
        context.emit("request", save);
        context.emit("response", { request: () => save });
        context.emit("requestfailed", save);
      })).toBeGreaterThanOrEqual(2_000);
    });

    it("after a write answered, then dropped with its document", async () => {
      expect(await heldOpenMs((b) => {
        const save = request("POST", SAVE);
        b.context.emit("request", save);
        b.context.emit("response", { request: () => save });
        newDocument(b);
      })).toBeGreaterThanOrEqual(2_000);
    });

    it("after a body that arrived: it can be a body the page reads, still streaming", async () => {
      expect(await heldOpenMs((b) => void answered(b))).toBeGreaterThanOrEqual(2_000);
    });

    it("not after a write that finished", async () => {
      expect(await heldOpenMs(({ context }) => {
        const save = request("POST", SAVE);
        context.emit("request", save);
        context.emit("response", { request: () => save });
        context.emit("requestfinished", save);
      })).toBeLessThan(2_000);
    });
  });

  it("a replay that throws is held to the same check: what it left open may land in the next", async () => {
    const report = await proveWith(write, true);
    expect(report.mutations[0]).toMatchObject({ outcome: "error" });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toMatch(UNANSWERED);
  });

  it("a replay that throws with nothing open is only an error", async () => {
    const report = await proveWith(() => undefined, true);
    expect(report.mutations[0]).toMatchObject({ outcome: "error" });
    expect(report.reason ?? "").not.toMatch(UNANSWERED);
  });

  describe("a replay that stalls", () => {
    const WRITE_OPEN = { restoreFailed: false, notIsolatedBy: "skip:1", isolation: "write-open" };
    const CLEAN = { restoreFailed: false, notIsolatedBy: null, isolation: null };

    it("with a write open taints its checkpoint: the resume says so, and never reads `proven`", async () => {
      await expect(proveWith(write, stalled(true), false)).rejects.toBeInstanceOf(JourneyVerifyStalledError);
      expect(taintOnFile()).toEqual(WRITE_OPEN);
      const resumed = await proveWith(() => undefined, false, true);
      expect(resumed.verdict).toBe("inconclusive");
      expect(resumed.reason).toMatch(UNANSWERED);
    });

    it("whose close never finished can't say what was open, which counts as open", async () => {
      await expect(proveWith(() => undefined, stalled(false), false)).rejects.toBeInstanceOf(JourneyVerifyStalledError);
      expect(taintOnFile()).toEqual(WRITE_OPEN);
    });

    it("with nothing open and a close that finished stays resumable and clean", async () => {
      await expect(proveWith(() => undefined, stalled(true), false)).rejects.toBeInstanceOf(JourneyVerifyStalledError);
      expect(taintOnFile()).toEqual(CLEAN);
    });
  });

  it("a write the new document sent itself is not dropped with the old one", async () => {
    const report = await proveWith((b) => {
      b.context.emit("request", request("GET", "http://127.0.0.1:9/", true));
      write(b);
      b.page.emit("domcontentloaded");
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toMatch(UNANSWERED);
  });
});
