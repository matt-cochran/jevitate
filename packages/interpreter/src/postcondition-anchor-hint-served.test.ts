import { describe, expect, it } from "vitest";
import type { Recording } from "@jevitate/recording";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { useSkippingTime, withSession } from "../../explore/src/testkit.js";
import { RecordingInterpreter } from "./interpreter.js";

useSkippingTime({ per: "all" });

/**
 * A step acts through its anchor, and its `visible` postcondition matches the recorded label exactly.
 * When the app's label changes, the action works and the check fails. The check stays strict (a label
 * is nearly all an own-target `visible` can catch, and a skip mutation's replay has no action to
 * tolerate it by), so the failure has to say what happened and what to do.
 */
const page = (label: string, id = "origins"): string => `<!doctype html><html><body><label for="${id}">${label}</label><textarea id="${id}"></textarea></body></html>`;
const LABEL = "Allowed origins";
const TARGET = { label: LABEL, anchor: { id: "origins" } };

const run = async (html: string, anchored: unknown = TARGET): Promise<{ outcome: string; error?: string }> =>
  withSession("jev-anchor-hint-", async (session) => {
    await session.page.setContent(html);
    const actor = CastActor.named("anchor-hint").whoCan(new BrowseTheWeb(session, ["http://127.0.0.1:1/"]));
    const recording = {
      version: "1",
      site: "http://127.0.0.1:1/",
      pages: [{ url: "/", steps: [{ step: { kind: "fill", target: anchored, value: { redacted: false, value: "x" }, expect: { kind: "visible", target: anchored } } }] }],
    } as unknown as Recording;
    return (await new RecordingInterpreter().run(actor, recording, {})) as { outcome: string; error?: string };
  });

describe("a visible postcondition whose element is still there by its anchor", () => {
  it("still fails, and names the changed label and the fix", async () => {
    const result = await run(page(`${LABEL}, one per line`));
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/postcondition failed/);
    expect(result.error).toMatch(/the element is still there by its recorded anchor \(id=origins\), but nothing matches the recorded name exactly/);
    expect(result.error).toMatch(/update the text in both the step's target and its expect, or re-record the step/);
  });

  it("gives no such reason when the anchor is gone too", async () => {
    const withoutAnchor = await run(page(`${LABEL}, one per line`, "other"));
    expect(withoutAnchor.outcome).toBe("failed");
    expect(withoutAnchor.error).not.toMatch(/recorded anchor/);
  });

  it("passes as before while the label matches", async () => {
    expect((await run(page(LABEL))).outcome).toBe("completed");
  });
});
