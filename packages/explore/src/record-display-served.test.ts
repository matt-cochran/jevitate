import { describe, expect, it } from "vitest";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { RunRecorder } from "./record.js";
import { snapshot, type Control } from "./snapshot.js";
import { useSkippingTime, withSession } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #497 served: a Jev/explore-authored Recording stores each acted control's visible label (the
 * snapshot's role + accessible name) on the step target as display metadata, never a credential
 * field's label and never one holding a registered secret.
 */

const SECRET = "ada@example.com";

const APP = `<main>
  <button type="button" data-testid="action-import">Import</button>
  <label for="pw">Password</label><input id="pw" type="password" data-testid="login-pw">
  <button type="button" data-testid="account">Signed in as ${SECRET}</button>
  <label>Upload a file <input type="file" data-testid="import-file" style="display:none"></label>
</main>`;

type Act = (rec: RunRecorder, c: Control) => void;

/** Snapshots the served page, records `act` on the control with `testId`, returns the Recording. */
async function recordOn(testId: string, act: Act, secrets: readonly string[] = []): Promise<{ recording: Recording; control: Control }> {
  return withSession("explore-record-display-", async (session) => {
    await session.page.setContent(`<!doctype html><html><body>${APP}</body></html>`);
    const snap = await snapshot(session.page, { secrets });
    const control = snap.controls.find((c) => c.descriptor.testId === testId);
    if (control === undefined) throw new Error(`no control ${testId}`);
    const rec = new RunRecorder("display-fixture", "1.0.0", secrets);
    rec.navigate("/app", 0);
    act(rec, control);
    return { recording: rec.finish(), control };
  });
}

const lastTarget = (r: Recording): TargetDescriptor | undefined => {
  const step = r.pages.flatMap((p) => p.steps).at(-1)?.step;
  return step !== undefined && "target" in step ? step.target : undefined;
};

const click: Act = (rec, c) => rec.click(c.descriptor, 1);

describe("Jev/explore recordings record a step's visible label (#497, real Chromium)", () => {
  it("a click on a test-id'd button records its role and accessible name", async () => {
    const { recording } = await recordOn("action-import", click);
    expect(lastTarget(recording)?.display).toEqual({ role: "button", name: "Import" });
  });

  it("the perceived control's own descriptor carries no display (its identity is unchanged)", async () => {
    const { control } = await recordOn("action-import", click);
    expect(control.descriptor).not.toHaveProperty("display");
  });

  it("a password field's label is never stored", async () => {
    const { recording } = await recordOn("login-pw", (rec, c) => rec.fill(c.descriptor, { redacted: true, length: 8 }, 1));
    expect(lastTarget(recording)).not.toHaveProperty("display");
  });

  it("a label holding a registered secret is never stored", async () => {
    const { recording } = await recordOn("account", click, [SECRET]);
    expect(lastTarget(recording)).not.toHaveProperty("display");
  });

  it("an upload to a hidden file input records its label", async () => {
    const { recording } = await recordOn("import-file", (rec, c) => rec.upload(c.descriptor, "contacts.csv", 1));
    expect(lastTarget(recording)?.display?.name).toBe("Upload a file");
  });
});
