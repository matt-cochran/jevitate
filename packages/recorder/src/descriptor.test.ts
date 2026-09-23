import { expect, test } from "vitest";
import type { ElementHandle, Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import {
  computeDescriptor,
  looksGenerated,
  readElementFacts,
  resolvesToSameElement,
} from "./descriptor.js";

const port = new PlaywrightBrowserPort();

/**
 * Unlike `recorder.test.ts`, these tests may use `page.setContent`.
 * `setContent` is `document.open()` + `document.write()`, and `document.open()`
 * strips document/window listeners — which breaks the *injected capture
 * listener*. `computeDescriptor` installs no listener and reads nothing but
 * live DOM state through a handle, so `setContent` is both safe and the
 * cheapest way to stand up a fixture here.
 */
async function withPage(html: string, body: (page: Page) => Promise<void>): Promise<void> {
  const session = await port.open({ headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    await session.page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    await body(session.page);
  } finally {
    await session.close();
  }
}

async function handleFor(page: Page, selector: string, nth = 0): Promise<ElementHandle<Node>> {
  const handle = await page.locator(selector).nth(nth).elementHandle();
  if (handle === null) throw new Error(`no element for ${selector} [${nth}]`);
  return handle;
}

/** Index of the element a selector resolves to among all `<button>`s. */
async function buttonIndex(page: Page, css: string): Promise<number> {
  return page.locator(css).evaluate((el) => Array.from(document.querySelectorAll("button")).indexOf(el as Element));
}

// === Scenario 1: testId ===

test(
  "an element with data-testid resolves to a testId descriptor at high stability",
  async () => {
    await withPage(`<button data-testid="foo">Zap</button>`, async (page) => {
      const handle = await handleFor(page, "button");
      const computed = await computeDescriptor(page, handle);

      expect(computed.descriptor).toEqual({ testId: "foo" });
      expect(computed.stability).toBe("high");
    });
  },
  120_000,
);

// === Scenario 2: role + name ===

test(
  "a plain <button>Send</button> resolves to a role+name descriptor at high stability",
  async () => {
    await withPage(`<button>Send</button>`, async (page) => {
      const handle = await handleFor(page, "button");
      const computed = await computeDescriptor(page, handle);

      expect(computed.descriptor).toEqual({ role: "button", name: "Send" });
      expect(computed.stability).toBe("high");
    });
  },
  120_000,
);

// === Scenario 3: label ===

test(
  "an input whose only distinguishing data is an associated <label> resolves to a label descriptor at medium stability",
  async () => {
    // role+name is genuinely unavailable: an `<input>` has no text content, no
    // `aria-label`, no `alt` and no `title`, so the accessible-name
    // approximation yields nothing and the role+name rung is never built.
    const html = `<form><label for="u">Username</label><input id="u" type="text" /></form>`;
    await withPage(html, async (page) => {
      const handle = await handleFor(page, "#u");
      const computed = await computeDescriptor(page, handle);

      // The element's stable id is captured as its replay anchor.
      expect(computed.descriptor).toEqual({ label: "Username", anchor: { id: "u" } });
      expect(computed.stability).toBe("medium");
      // A css rung still validated underneath it, kept for self-healing.
      expect(computed.alternates.some((a) => typeof a.css === "string")).toBe(true);
    });
  },
  120_000,
);

// === Scenario 4: dynamic-looking id only ===

test(
  "an element identified only by a generated-looking id falls through to css at low stability, never using that id",
  async () => {
    const dynamicId = "dyn-4821990";
    const html = `<div id="panel"><span id="${dynamicId}"></span></div><div id="other"><span></span></div>`;
    await withPage(html, async (page) => {
      const handle = await handleFor(page, `#${dynamicId}`);
      const computed = await computeDescriptor(page, handle);

      expect(Object.keys(computed.descriptor)).toEqual(["css"]);
      expect(computed.stability).toBe("low");
      expect(computed.descriptor.css).not.toContain(dynamicId);
      // And it really does resolve back, uniquely, to that element.
      expect(await page.locator(computed.descriptor.css!).count()).toBe(1);
      expect(await resolvesToSameElement(page, page.locator(computed.descriptor.css!), handle)).toBe(true);
    });
  },
  120_000,
);

// === Scenario 5: ambiguous elements ===

test(
  "two identical buttons each get a descriptor that resolves to that specific button, via role+name plus an ordinal instead of falling to css",
  async () => {
    await withPage(`<div id="row"><button>Ok</button><button>Ok</button></div>`, async (page) => {
      const first = await handleFor(page, "button", 0);
      const second = await handleFor(page, "button", 1);

      const a = await computeDescriptor(page, first);
      const b = await computeDescriptor(page, second);

      // role+name and text both match BOTH buttons, so neither rung is
      // unique on its own — but each is corroborated with an `ordinal`
      // (Task 1: TargetDescriptor ordinal/container) recording *which*
      // match was acted on, which is a strictly better selector than
      // falling all the way down to a generated-looking css nth-of-type
      // path. Stability is capped one notch, since the underlying rung is
      // no longer unique by itself.
      expect(a.descriptor).toEqual({ role: "button", name: "Ok", ordinal: 0, candidates: 2 });
      expect(b.descriptor).toEqual({ role: "button", name: "Ok", ordinal: 1, candidates: 2 });
      expect(a.stability).toBe("medium");
      expect(b.stability).toBe("medium");

      // The demoted text+ordinal rung and the plain (already-unique) css
      // rung both still validate and are kept as alternates.
      expect(a.alternates).toContainEqual({ text: "Ok", ordinal: 0, candidates: 2 });
      expect(b.alternates).toContainEqual({ text: "Ok", ordinal: 1, candidates: 2 });
      expect(a.alternates.some((alt) => typeof alt.css === "string")).toBe(true);
      expect(b.alternates.some((alt) => typeof alt.css === "string")).toBe(true);

      // Each descriptor really does resolve back, uniquely, to its own button.
      expect(await resolvesToSameElement(page, page.getByRole("button", { name: "Ok" }).nth(0), first)).toBe(true);
      expect(await resolvesToSameElement(page, page.getByRole("button", { name: "Ok" }).nth(1), second)).toBe(true);
      const aCss = a.alternates.find((alt) => typeof alt.css === "string")!.css!;
      const bCss = b.alternates.find((alt) => typeof alt.css === "string")!.css!;
      expect(await buttonIndex(page, aCss)).toBe(0);
      expect(await buttonIndex(page, bCss)).toBe(1);
    });
  },
  120_000,
);

// === The identity check, exercised directly ===

test(
  "resolvesToSameElement distinguishes two elements a selector could plausibly mean",
  async () => {
    await withPage(`<div id="row"><button>Ok</button><button>Ok</button></div>`, async (page) => {
      const first = await handleFor(page, "button", 0);
      const second = await handleFor(page, "button", 1);

      expect(await resolvesToSameElement(page, page.locator("button:nth-of-type(1)"), first)).toBe(true);
      // Uniquely resolving, but to the OTHER element: uniqueness alone would
      // have wrongly accepted this.
      expect(await resolvesToSameElement(page, page.locator("button:nth-of-type(1)"), second)).toBe(false);
      // Ambiguous locator: no single resolved element to compare.
      expect(await resolvesToSameElement(page, page.locator("button"), first)).toBe(false);
      // Matches nothing at all.
      expect(await resolvesToSameElement(page, page.locator("#nope"), first)).toBe(false);
    });
  },
  120_000,
);

// === Alternates ===

test(
  "every lower rung that also validated is kept as an alternate",
  async () => {
    await withPage(`<button data-testid="send">Send</button>`, async (page) => {
      const handle = await handleFor(page, "button");
      const computed = await computeDescriptor(page, handle);

      expect(computed.descriptor).toEqual({ testId: "send" });
      expect(computed.stability).toBe("high");
      expect(computed.alternates).toContainEqual({ role: "button", name: "Send" });
      expect(computed.alternates.some((a) => typeof a.css === "string")).toBe(true);
      // Alternates stay in ladder order and never repeat the primary.
      expect(computed.alternates).not.toContainEqual({ testId: "send" });
    });
  },
  120_000,
);

// === data-test is built as a candidate but cannot validate ===

test(
  "a data-test attribute does not survive validation, because getByTestId reads data-testid",
  async () => {
    await withPage(`<button data-test="legacy">Confirm</button>`, async (page) => {
      const handle = await handleFor(page, "button");
      const computed = await computeDescriptor(page, handle);

      // The testId candidate IS built from `data-test`, but `page.getByTestId`
      // queries `data-testid`, so it resolves nothing and is rejected.
      expect(computed.descriptor).toEqual({ role: "button", name: "Confirm" });
      expect(computed.stability).toBe("high");
      expect(computed.alternates).not.toContainEqual({ testId: "legacy" });
    });
  },
  120_000,
);

// === Generated-value downgrade ===

test(
  "a generated-looking testId still wins the ladder but is flagged low stability",
  async () => {
    await withPage(`<button data-testid="row-8f3a91c7">Edit</button>`, async (page) => {
      const handle = await handleFor(page, "button");
      const computed = await computeDescriptor(page, handle);

      expect(computed.descriptor).toEqual({ testId: "row-8f3a91c7" });
      expect(computed.stability).toBe("low");
    });
  },
  120_000,
);

// === The documented additions to the accessible-name approximation ===

test(
  "an <input type=submit> is named by its value, and an <img> by its alt",
  async () => {
    await withPage(`<form><input type="submit" value="Save" /></form>`, async (page) => {
      const computed = await computeDescriptor(page, await handleFor(page, "input"));
      expect(computed.descriptor).toEqual({ role: "button", name: "Save" });
      expect(computed.stability).toBe("high");
    });

    await withPage(`<img src="data:," alt="Logo" />`, async (page) => {
      const computed = await computeDescriptor(page, await handleFor(page, "img"));
      expect(computed.descriptor).toEqual({ role: "img", name: "Logo" });
      expect(computed.stability).toBe("high");
    });
  },
  120_000,
);

// === Cleanup of the temporary capture attribute ===

test(
  "the temporary data-jevitate-eid attribute is removed, whether or not it was there",
  async () => {
    const html = `<button data-jevitate-eid="7" data-testid="tagged">Tagged</button>
                  <button data-testid="untagged">Untagged</button>`;
    await withPage(html, async (page) => {
      const tagged = await handleFor(page, `[data-testid="tagged"]`);
      await computeDescriptor(page, tagged);
      expect(await page.locator(`[data-testid="tagged"]`).getAttribute("data-jevitate-eid")).toBeNull();

      const untagged = await handleFor(page, `[data-testid="untagged"]`);
      const computed = await computeDescriptor(page, untagged);
      expect(computed.descriptor).toEqual({ testId: "untagged" });
      expect(await page.locator(`[data-testid="untagged"]`).getAttribute("data-jevitate-eid")).toBeNull();
    });
  },
  120_000,
);

// === The stability heuristic, in isolation ===

test("looksGenerated flags uuids, long hex runs and digit runs, and leaves human names alone", () => {
  expect(looksGenerated("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
  expect(looksGenerated("a1b2c3d4-e5f6-7890")).toBe(true);
  expect(looksGenerated("item-8234719")).toBe(true);
  expect(looksGenerated("row-8f3a91c7")).toBe(true);

  expect(looksGenerated("submit-button")).toBe(false);
  expect(looksGenerated("username")).toBe(false);
  expect(looksGenerated("step-3")).toBe(false);
  expect(looksGenerated("h2")).toBe(false);
});

// === Scenario: the in-page fact reader never touches a secret value ===

test(
  "reads an <input>'s value only when the accessible name comes from it, so a password's value never crosses into Node",
  async () => {
    const secret = "pw-must-never-cross-the-wire";
    const otp = "one-time-424242-never-crosses";
    await withPage(
      `<form>
         <label>Password <input id="pw" type="password" value="${secret}" /></label>
         <label>Code <input id="otp" type="text" autocomplete="one-time-code" value="${otp}" /></label>
         <label>Notes <input id="notes" type="text" value="a draft nobody asked to keep" /></label>
         <input id="send" type="submit" value="Send it" />
       </form>`,
      async (page) => {
        const options = {
          generatedPatterns: ["[0-9]{4}"],
          valueNamedInputTypes: ["button", "submit", "reset"],
        };
        const factsFor = async (selector: string): Promise<{ value: string | null; inputType: string | null }> => {
          const handle = await handleFor(page, selector);
          return handle.evaluate(readElementFacts, options);
        };

        // The value is read ONLY where the accessible name genuinely comes from
        // it. `<input type=submit>` has no text content at all, so without this
        // it could never reach the role+name rung.
        expect(await factsFor("#send")).toMatchObject({ inputType: "submit", value: "Send it" });

        // Everything else: not read, not returned, never on the CDP wire —
        // where DEBUG=pw:protocol or a Playwright trace could put it on disk.
        for (const selector of ["#pw", "#otp", "#notes"]) {
          const facts = await factsFor(selector);
          expect(facts.value, `${selector} leaked its value`).toBeNull();
        }

        // And nothing else in the facts smuggles it either (a `value` attribute
        // is serialized into the DOM, so a css path or text could in principle
        // carry it).
        for (const selector of ["#pw", "#otp"]) {
          const handle = await handleFor(page, selector);
          const facts = await handle.evaluate(readElementFacts, options);
          const serialized = JSON.stringify(facts);
          expect(serialized).not.toContain(secret);
          expect(serialized).not.toContain(otp);
        }

        // The whole descriptor pipeline stays clean too, and still works: the
        // password field is identified by its label.
        const pw = await computeDescriptor(page, await handleFor(page, "#pw"));
        // An identifier (the id) — never the value — anchors it.
        expect(pw.descriptor).toEqual({ label: "Password", anchor: { id: "pw" } });
        expect(JSON.stringify(pw)).not.toContain(secret);
      },
    );
  },
  120_000,
);
