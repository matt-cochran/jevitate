import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { RecordingSchema, promoteToVariable, boundVariables, type StepRef, type Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { Recorder } from "./recorder.js";

/**
 * The Task 3 / escalation-A exit criterion: a *recorded* `fill` step
 * (redacted, as every captured value is) replays successfully once, and only
 * once, it has been promoted to a variable with `promoteToVariable` — with no
 * hand-editing of the captured artifact anywhere in between.
 *
 * This is deliberately narrower than `round-trip.test.ts` (the A.2 proof):
 * that test hand-edits `fill.step.value = { var: "username" }` and composes a
 * hand-authored `extract` step onto the recording, to prove captured and
 * authored steps share one schema. This test proves the *other* half of the
 * design — that `stopAuthoring()` + `promoteToVariable()` together are a
 * complete, mechanical replacement for that hand-edit. The only transform
 * applied to the recorded artifact here is the single `promoteToVariable`
 * call; nothing else about it is touched.
 */

const port = new PlaywrightBrowserPort();

let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

type Session = Awaited<ReturnType<typeof port.open>>;

/** Each call gets its own profile directory, so two sessions share no state. */
async function withSession<T>(prefix: string, body: (session: Session) => Promise<T>): Promise<T> {
  const profileDir = await mkdtemp(join(tmpdir(), prefix));
  const session = await port.open({
    profileDir,
    headless: true,
    allowedOrigins: [site.url],
    baseUrl: site.url,
  });
  try {
    return await body(session);
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

/** Finds the `{page, step}` coordinates of the recording's sole `fill` step. */
function findFillStepRef(recording: Recording): StepRef {
  for (let page = 0; page < recording.pages.length; page++) {
    const steps = recording.pages[page]!.steps;
    for (let step = 0; step < steps.length; step++) {
      if (steps[step]!.step.kind === "fill") return { page, step };
    }
  }
  throw new Error(`no fill step captured; pages: ${JSON.stringify(recording.pages, null, 2)}`);
}

test(
  "recorded fill replays through the interpreter once promoted to a variable",
  async () => {
    // === Phase A — capture a real journey with the Recorder ===
    const { recording, values } = await withSession("doit-replayable-record-", async (session) => {
      const recorder = new Recorder(session, "example-site");
      await recorder.start("record a login and reach the inbox");

      const page = session.page;
      await page.goto(`${site.url}/login`);
      await page.getByLabel("Username").fill("jane");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/inbox$/);

      return recorder.stopAuthoring("reached the inbox");
    });

    expect(() => RecordingSchema.parse(recording)).not.toThrow();
    expect(recording.pages.map((p) => p.url)).toEqual(["/login", "/inbox"]);

    // The captured value lives only in the local-authoring side-channel — the
    // persisted `Recording` itself carries a redacted placeholder. Asserting
    // this here is a sanity check on the side-channel's content; the replay
    // below never reads `values` — only `promoteToVariable` plus the var
    // supplied at `run()` time does that job.
    const fillRef = findFillStepRef(recording);
    const fillStep = recording.pages[fillRef.page]!.steps[fillRef.step]!.step;
    if (fillStep.kind !== "fill") throw new Error(`expected a fill step at ${JSON.stringify(fillRef)}`);
    expect(fillStep.target).toEqual({ role: "textbox", name: "Username" });
    expect(fillStep.value).toEqual({ redacted: true, length: "jane".length });
    expect(values.get(`${fillRef.page}:${fillRef.step}`)).toBe("jane");

    // === Phase B — the ONLY transformation: promote the fill to a variable ===
    const promoted = promoteToVariable(recording, fillRef, "username");
    expect(boundVariables(promoted)).toEqual(["username"]);

    // The promotion must not have touched anything else about the artifact.
    expect(promoted.pages.map((p) => p.url)).toEqual(recording.pages.map((p) => p.url));
    const promotedFill = promoted.pages[fillRef.page]!.steps[fillRef.step]!.step;
    if (promotedFill.kind !== "fill") throw new Error("promotion changed the step kind");
    expect(promotedFill.value).toEqual({ var: "username" });
    expect(promotedFill.target).toEqual(fillStep.target);

    expect(() => RecordingSchema.parse(promoted)).not.toThrow();

    // === Phase C — replay in a genuinely fresh, cookie-less session ===
    await withSession("doit-replayable-replay-", async (fresh) => {
      const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [site.url]));
      const result = await new RecordingInterpreter().run(actor, promoted, { username: "jane" });
      if (result.outcome !== "completed") {
        throw new Error(`expected the promoted recording to replay to completion, got ${JSON.stringify(result)}`);
      }
      expect(result.outcome).toBe("completed");
      expect(fresh.page.url()).toContain("/inbox");
    });
  },
  120_000,
);
