import { beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { ProfileManager } from "@jevitate/daemon";
import type { Recording } from "@jevitate/recording";
import { Recorder } from "@jevitate/recorder";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { buildProgram } from "./program.js";
import { runRecording, type RunRecordingResult } from "./record-api.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #564 served: `jevitate record` writes a `{recording, values}` take file that
 * `recording diff`/`postdoc`/`promote` accept. Drives the real recorder against
 * a served fictional page twice with different text/select values, and proves
 * both the variable classification and that a typed password / one-time code
 * never reach the written file.
 */

const ORIGIN = "http://jevitate.test";
const SECRET_PASSWORD = "correct-horse-battery-staple";
const SECRET_OTP = "918273";

const APP = `<!doctype html><html><body>
  <form onsubmit="event.preventDefault()">
    <label for="comment">Comment</label>
    <input id="comment" data-testid="comment" type="text" name="comment">
    <label for="plan">Plan</label>
    <select id="plan" data-testid="plan" name="plan">
      <option value="red">Red</option>
      <option value="blue">Blue</option>
    </select>
    <label for="pw">Password</label>
    <input id="pw" data-testid="pw" type="password" autocomplete="current-password" name="pw">
    <label for="otp">Code</label>
    <input id="otp" data-testid="otp" type="text" autocomplete="one-time-code" name="otp">
  </form>
</body></html>`;

/** Waits until `count` distinct elements have delivered an action to the recorder. */
async function waitForCapturedActions(recorder: Recorder, count: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const eids = new Set(
      recorder.events
        .filter((e) => e.type === "action")
        .map((e) => (e.type === "action" ? e.payload.eid : ""))
    );
    if (eids.size >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} captured actions`);
}

/** Records one take with the real recorder, returning the emitted file path + result. */
async function recordTake(tag: string, comment: string, plan: string): Promise<RunRecordingResult> {
  const outDir = await mkdtemp(join(tmpdir(), `record-take-${tag}-`));
  const port = new PlaywrightBrowserPort();
  let recorder: Recorder | undefined;
  let page: Page | undefined;

  return runRecording({
    url: `${ORIGIN}/app`,
    allowlist: [ORIGIN],
    outDir,
    headless: true,
    browserPortFactory: () => ({
      async open(o) {
        const session = await port.open(o);
        page = session.page as unknown as Page;
        await session.page.route("**/*", (route) =>
          route.fulfill({ contentType: "text/html", body: APP })
        );
        return session;
      },
    }),
    recorderFactory: (session, site) => {
      recorder = new Recorder(session, site);
      return recorder;
    },
    waitForStop: async () => {
      if (page === undefined || recorder === undefined) throw new Error("session was not captured");
      await page.getByTestId("comment").fill(comment);
      await page.getByTestId("plan").selectOption(plan);
      await page.getByTestId("pw").fill(SECRET_PASSWORD);
      await page.getByTestId("otp").fill(SECRET_OTP);
      await waitForCapturedActions(recorder, 4);
    },
    nowIso: () => "2026-09-21T12:00:00.000Z",
  });
}

interface TakeFile {
  recording: Recording;
  values: Record<string, string>;
}

/** A `{page, step}` ref of every fill/select step, flattened in page/step order. */
function valueStepRefs(take: TakeFile): Array<{ page: number; step: number }> {
  const refs: Array<{ page: number; step: number }> = [];
  take.recording.pages.forEach((p, pageIdx) =>
    p.steps.forEach((recorded, stepIdx) => {
      if (recorded.step.kind === "fill" || recorded.step.kind === "select") {
        refs.push({ page: pageIdx, step: stepIdx });
      }
    })
  );
  return refs;
}

async function runCli(args: string[]): Promise<{ lines: string[]; parsed: unknown }> {
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused-in-these-tests") });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return { lines, parsed: JSON.parse(lines.join("")) };
}

let takeA: TakeFile;
let takeB: TakeFile;
let takeAPath: string;
let takeBPath: string;
let rawA: string;
let rawB: string;

beforeAll(async () => {
  const resultA = await recordTake("a", "first comment", "red");
  const resultB = await recordTake("b", "second comment", "blue");
  takeAPath = resultA.recordingPath;
  takeBPath = resultB.recordingPath;
  rawA = await readFile(takeAPath, "utf8");
  rawB = await readFile(takeBPath, "utf8");
  takeA = JSON.parse(rawA) as TakeFile;
  takeB = JSON.parse(rawB) as TakeFile;
});

describe("record writes a take file `recording diff`/`postdoc` accept (#564, real Chromium)", () => {
  it("recording diff accepts both emitted take files", async () => {
    const { parsed } = await runCli(["recording", "diff", takeAPath, takeBPath, "--json"]);
    expect((parsed as { ok: boolean }).ok).toBe(true);
  });

  it("recording diff classifies the differing text and select columns as variable", async () => {
    const { parsed } = await runCli(["recording", "diff", takeAPath, takeBPath, "--json"]);
    const columns = (parsed as { data: { columns: Array<{ kind: string; values: string[] }> } }).data.columns;
    const variableValues = columns.filter((c) => c.kind === "variable").map((c) => c.values);
    expect(variableValues.slice().sort()).toEqual([
      ["first comment", "second comment"],
      ["red", "blue"],
    ].sort());
  });

  it("recording postdoc promotes the text and select columns to the named variables", async () => {
    const refs = valueStepRefs(takeA);
    const names = ["comment", "plan"];
    const decisions = refs.map((step, i) => ({ step, classify: "variable" as const, name: names[i]! }));
    const decisionsPath = join(await mkdtemp(join(tmpdir(), "record-take-decisions-")), "decisions.json");
    await writeFile(decisionsPath, JSON.stringify(decisions));

    const { parsed } = await runCli([
      "recording", "postdoc", takeAPath, takeBPath, "--decisions", decisionsPath, "--json",
    ]);
    const result = (parsed as { data: Recording }).data;
    const bound = valueStepRefs({ recording: result, values: {} }).map(({ page, step }) => {
      const s = result.pages[page]!.steps[step]!.step;
      return s.kind === "fill" || s.kind === "select" ? s.value : undefined;
    });
    expect(bound).toEqual([{ var: "comment" }, { var: "plan" }]);
  });

  it("the typed password never appears in the emitted take files", () => {
    expect([rawA, rawB].some((raw) => raw.includes(SECRET_PASSWORD))).toBe(false);
  });

  it("the typed one-time code never appears in the emitted take files", () => {
    expect([rawA, rawB].some((raw) => raw.includes(SECRET_OTP))).toBe(false);
  });

  it("recording promote binds a variable on an emitted take file", async () => {
    const ref = valueStepRefs(takeA)[0]!;
    const { parsed } = await runCli([
      "recording", "promote", takeAPath, "--page", String(ref.page), "--step", String(ref.step), "--var", "comment",
    ]);
    const recording = parsed as Recording;
    expect(recording.pages[ref.page]!.steps[ref.step]!.step).toMatchObject({ value: { var: "comment" } });
  });
});
