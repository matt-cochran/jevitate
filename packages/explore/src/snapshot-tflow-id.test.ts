import { describe, expect, it } from "vitest";
import { snapshot } from "./index.js";
import { withSession, useSkippingTime } from "./testkit.js";

useSkippingTime({ per: "all" });

async function controlsOf(html: string) {
  return withSession("explore-snapshot-tflow-", async (session) => {
    await session.page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    return (await snapshot(session.page)).controls;
  });
}

describe("snapshot controls carry data-tflow-id as metadata (#468)", () => {
  it("a control with a tflowId carries it", async () => {
    const [c] = await controlsOf(`<button data-testid="send" data-tflow-id="invite.send">Send</button>`);
    expect(c?.tflowId).toBe("invite.send");
  });

  it("the tflowId does not displace the testId rung", async () => {
    const [c] = await controlsOf(`<button data-testid="send" data-tflow-id="invite.send">Send</button>`);
    expect(c?.descriptor.testId).toBe("send");
  });

  it("the control records which attribute supplied its testId", async () => {
    const [c] = await controlsOf(`<button data-testid="send">Send</button>`);
    expect(c?.testIdAttr).toBe("data-testid");
  });

  it("a control without a tflowId has none", async () => {
    const [c] = await controlsOf(`<button data-testid="send">Send</button>`);
    expect(c).not.toHaveProperty("tflowId");
  });

  it("a tflowId-only control is still described by its accessible name", async () => {
    const [c] = await controlsOf(`<button data-tflow-id="invite.send">Send</button>`);
    expect(c?.descriptor).toMatchObject({ role: "button", name: "Send" });
  });
});
