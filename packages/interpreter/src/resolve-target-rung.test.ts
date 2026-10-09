import { describe, expect, it } from "vitest";
import type { Recording } from "@jevitate/recording";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { useSkippingTime, withSession } from "../../explore/src/testkit.js";
import { RecordingInterpreter } from "./interpreter.js";
import { resolveTarget, type ResolvedTarget } from "./resolve-target.js";

// #304: idle waits skip; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #470: replay honours the attribute a test id was recorded from (Playwright's `getByTestId` only
 * matches `data-testid`), refuses `data-tflow-id` as a locator, and reports — as metadata only — the
 * rung each step's target actually resolved by.
 */

const PAGE = `<!doctype html><html><body><main>
  <h1>Contacts</h1>
  <button data-cy="save">Save</button>
  <button data-test="publish">Publish</button>
  <button data-tflow-id="contact.archive">Archive</button>
  <ul><li><button>Edit</button></li><li><button>Edit</button></li></ul>
</main></body></html>`;

async function onPage<T>(body: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  return withSession("jev-rung-", async (session) => {
    await session.page.setContent(PAGE);
    return body(session.page);
  });
}

describe("test ids from another attribute resolve by [attr=value]", () => {
  it("a data-cy test id resolves to its element", async () => {
    const text = await onPage(async (page) => (await resolveTarget(page, { testId: "save", testIdAttr: "data-cy" }, { timeoutMs: 500 })).textContent());
    expect(text).toBe("Save");
  });

  it("a data-test test id resolves to its element", async () => {
    const text = await onPage(async (page) => (await resolveTarget(page, { testId: "publish", testIdAttr: "data-test" }, { timeoutMs: 500 })).textContent());
    expect(text).toBe("Publish");
  });

  it("data-tflow-id is refused as a test-id attribute", async () => {
    const outcome = await onPage(async (page) =>
      resolveTarget(page, { testId: "contact.archive", testIdAttr: "data-tflow-id" }, { timeoutMs: 500 }).then(
        () => "resolved",
        (err: Error) => err.message,
      ),
    );
    expect(outcome).toMatch(/data-tflow-id is tracking metadata/);
  });
});

describe("the rung a target resolved by is reported", () => {
  it("a role+name narrowed by an ordinal reports the rung and the ordinal", async () => {
    const seen: ResolvedTarget[] = [];
    await onPage(async (page) => resolveTarget(page, { role: "button", name: "Edit", ordinal: 1, candidates: 2 }, { timeoutMs: 500, onResolved: (v) => seen.push(v) }));
    expect(seen).toEqual([{ rung: "role+name", ordinal: 1, candidates: 2 }]);
  });

  it("a replay's result lists each step's resolution by flat index and step id", async () => {
    const recording: Recording = {
      version: "1",
      site: "http://127.0.0.1:1/",
      pages: [
        {
          url: "/",
          steps: [
            { stepId: "s-save", step: { kind: "click", target: { testId: "save", testIdAttr: "data-cy" }, expect: { kind: "visible", target: { role: "heading", name: "Contacts" } } } },
            { stepId: "s-pub", step: { kind: "click", target: { role: "button", name: "Publish" }, expect: { kind: "visible", target: { role: "heading", name: "Contacts" } } } },
          ],
        },
      ],
    };
    const result = await withSession("jev-rung-run-", async (session) => {
      await session.page.setContent(PAGE);
      const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, []));
      return new RecordingInterpreter().run(actor, recording, {});
    });
    expect(result.resolved).toEqual([
      { index: 0, stepId: "s-save", rung: "testId", testIdAttr: "data-cy" },
      { index: 1, stepId: "s-pub", rung: "role+name" },
    ]);
  });
});
