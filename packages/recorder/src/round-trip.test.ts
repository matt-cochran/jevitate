import { afterAll, beforeAll, expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer, SEED_THREADS } from "@jevitate/example-site";
import { RecordingSchema, type RecordedStep, type Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { Recorder } from "./recorder.js";

/**
 * The A.2 exit criterion: a journey **demonstrated** in a real browser becomes
 * a `Recording` that a *different*, cookie-less browser session can re-execute.
 *
 * Nothing here is simulated. The fixture is the real `apps/example-site`
 * Fastify server; the journey is driven with ordinary Playwright locator calls,
 * so every step the recorder sees came from a genuine DOM event; and the replay
 * runs through `@jevitate/interpreter` exactly as production would.
 *
 * The fixture's login is username-only on purpose. A real password field would
 * be captured as a `handback` (its value is never read out of the page — see
 * `assemble.ts`'s `SECRET_PROMPT`), which is the schema's spelling of
 * "human-only" and would make this journey un-replayable end to end by design.
 */

const port = new PlaywrightBrowserPort();

/** Confirmed from `apps/example-site/src/data.ts`, not assumed. */
const FIRST_THREAD = SEED_THREADS[0]!;
const FIRST_MESSAGE = FIRST_THREAD.messages[0]!;
const MESSAGE_CSS = `li[data-message-id='${FIRST_MESSAGE.id}']`;

let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

const flatSteps = (rec: Recording): RecordedStep[] => rec.pages.flatMap((p) => p.steps);

type Session = Awaited<ReturnType<typeof port.open>>;

/** Each call gets its own profile directory, so two sessions share no state. */
async function withSession<T>(prefix: string, body: (session: Session) => Promise<T>): Promise<T> {
  const session = await port.open({
    headless: true,
    allowedOrigins: [site.url],
    baseUrl: site.url,
  });
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

test(
  "golden round-trip: a journey captured by the Recorder replays through the interpreter in a fresh session",
  async () => {
    // === Phase A — capture a real journey ===
    const recording = await withSession("jevitate-round-trip-record-", async (session) => {
      const recorder = new Recorder(session, "example-site");
      await recorder.start("record a login, open the inbox, and read the first thread");

      const page = session.page;
      await page.goto(`${site.url}/login`);
      // Real user gestures: `fill`/`click` dispatch the same DOM events a human
      // would, which is what the in-page listener captures. No `page.evaluate`.
      await page.getByLabel("Username").fill("jane");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);
      await page.getByRole("link", { name: FIRST_THREAD.subject }).click();
      await page.waitForURL(new RegExp(`/thread/${FIRST_THREAD.id}$`));

      return recorder.stop("reached the thread");
    });

    // `stop()` already parsed this internally; re-parsing is the cheap
    // belt-and-braces check that what crossed the return boundary is still the
    // artifact the schema accepts.
    expect(() => RecordingSchema.parse(recording)).not.toThrow();

    const steps = flatSteps(recording);

    // Nothing degraded to "a human has to do this bit". A click that navigates
    // away used to lose its element before it could be described; capturing the
    // element's facts in-page, synchronously, is what keeps these real steps.
    expect(steps.filter((s) => s.step.kind === "handback")).toEqual([]);

    // The journey the recorder saw: /login, /inbox, /thread/t-1.
    expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox", `/thread/${FIRST_THREAD.id}`]);
    expect(recording.intent).toBe("record a login, open the inbox, and read the first thread");
    expect(recording.retro).toBe("reached the thread");

    // The descriptor ladder picked the *accessible* rung, not a css path — the
    // whole point of describing an element rather than pointing at it.
    const signIn = steps.find((s) => s.step.kind === "click" && s.step.target.name === "Sign in");
    if (signIn === undefined || signIn.step.kind !== "click") {
      throw new Error(`no Sign in click captured; steps: ${JSON.stringify(steps, null, 2)}`);
    }
    expect(signIn.step.target).toEqual({ role: "button", name: "Sign in" });
    expect(signIn.step.target.css).toBeUndefined();

    const threadLink = steps.find((s) => s.step.kind === "click" && s.step.target.name === FIRST_THREAD.subject);
    if (threadLink === undefined || threadLink.step.kind !== "click") {
      throw new Error(`no inbox link click captured; steps: ${JSON.stringify(steps, null, 2)}`);
    }
    expect(threadLink.step.target).toEqual({ role: "link", name: FIRST_THREAD.subject });
    expect(threadLink.step.target.css).toBeUndefined();

    // === Phase B — compose the captured artifact with hand-authored edits ===

    // B1. The recorder redacts *every* captured value (`assemble.ts`: "the
    // recorder is not the component that gets to decide a value is harmless"),
    // and the interpreter refuses to type a redacted constant. So a captured
    // `fill` is replayable only once someone rebinds it to a variable and
    // supplies the value at run time — which is exactly the intended handover,
    // and is done here rather than worked around.
    const fill = steps.find((s) => s.step.kind === "fill");
    if (fill === undefined || fill.step.kind !== "fill") {
      throw new Error(`no fill captured; steps: ${JSON.stringify(steps, null, 2)}`);
    }
    // The recorder may also capture a stable anchor (the input's `name` attribute) depending on when
    // the descriptor is read; either shape replays. Require the semantic locator, allow that anchor.
    expect(fill.step.target).toMatchObject({ role: "textbox", name: "Username" });
    if ("anchor" in fill.step.target) expect(fill.step.target.anchor).toEqual({ name: "username" });
    expect(fill.step.value).toEqual({ redacted: true, length: "jane".length });
    fill.step.value = { var: "username" };

    // B2. The recorder captures *actions*; "read this text" is not one, since a
    // human triggers no DOM event by reading. An `extract` is therefore
    // authored by hand onto the last page — proving captured and authored steps
    // are the same closed schema and compose into one artifact.
    recording.pages[recording.pages.length - 1]!.steps.push({
      step: {
        kind: "extract",
        target: { css: MESSAGE_CSS },
        as: "messageText",
        expect: { kind: "textIncludes", target: { css: MESSAGE_CSS }, text: FIRST_MESSAGE.text },
      },
    });

    // Both hand edits must leave a schema-valid artifact — the schema is the
    // contract, so a failure here is a bug in the edit, never a reason to skip
    // the check.
    const edited = RecordingSchema.parse(recording);

    // === Phase C — replay in a genuinely fresh session ===
    // A new profile directory, so no cookie, tab or storage from the recording
    // session survives into the replay: the recording has to log in again from
    // scratch, on its own.
    await withSession("jevitate-round-trip-replay-", async (fresh) => {
      const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [site.url]));
      const result = await new RecordingInterpreter().run(actor, edited, { username: "jane" });
      if (result.outcome !== "completed") {
        throw new Error(`expected the captured recording to replay to completion, got ${JSON.stringify(result)}`);
      }
      expect(result.outcome).toBe("completed");
      expect(result.vars.messageText).toContain(FIRST_MESSAGE.text);
      expect(fresh.page.url()).toContain(`/thread/${FIRST_THREAD.id}`);
    });
  },
  120_000,
);
