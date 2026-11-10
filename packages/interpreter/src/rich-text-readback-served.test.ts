import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import type { TextEdit } from "@jevitate/recording";
import { applyTextEdit } from "./rich-text.js";

/**
 * F4 (0.29.0 accepted limit): `editText` reported ok with nothing typed when the editor rejected the
 * input or the anchor sat in a non-editable child, on the keyboard path and the bound-secret path alike.
 * The edit now reads the element's text back on every path and fails typed (`E_EDIT_NOT_APPLIED`)
 * when the change did not land — never echoing the value.
 */
let session: BrowserSession;

beforeAll(async () => {
  session = await new PlaywrightBrowserPort().open({ headless: true });
}, 60_000);

afterAll(async () => {
  await session?.close();
});

const VALUE = "Zq7Pw12x";
const page = () => session.page;
const ed = () => page().locator("#ed");
const text = async (): Promise<string> => (await ed().evaluate((el) => el.textContent ?? "")).replace(/\s+/g, " ").trim();

const REJECTS = `<div id="ed" contenteditable="true" onbeforeinput="event.preventDefault()">Hello world</div>`;
const NON_EDITABLE_END = `<div id="ed" contenteditable="true"><p>Hello world</p><span contenteditable="false">tail</span></div>`;
// Lexical-style: the app owns the DOM, applying each insert from `beforeinput` in a microtask.
const MICROTASK_MODEL = `<div id="ed" contenteditable="true">Hello world</div><script>
  const el = document.getElementById("ed");
  el.addEventListener("beforeinput", (e) => {
    if (e.inputType !== "insertText") return;
    e.preventDefault();
    const data = e.data;
    queueMicrotask(() => {
      const sel = window.getSelection(); const r = sel.getRangeAt(0); r.deleteContents();
      const t = document.createTextNode(data); r.insertNode(t); r.setStartAfter(t); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
    });
  });
</script>`;

const edit = (e: Partial<TextEdit>, bound = false) =>
  applyTextEdit(page(), ed(), { anchor: { at: "end" }, action: "insertAfter", value: VALUE, ...e, ...(bound ? { boundSecret: true } : {}) } as TextEdit & { boundSecret?: boolean });

async function refusal(p: Promise<void>): Promise<Error & { code?: string }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error & { code?: string },
  );
  expect(err, "the edit must not report ok").not.toBeNull();
  return err!;
}

describe("editText reads its edit back (F4)", () => {
  it.each([
    ["keyboard", false],
    ["bound secret", true],
  ])("an editor that rejects input: refused, typed, value not echoed (%s path)", async (_path, bound) => {
    await page().setContent(REJECTS);
    const err = await refusal(edit({}, bound));
    expect(err.code).toBe("E_EDIT_NOT_APPLIED");
    expect(err.message).toMatch(/^E_EDIT_NOT_APPLIED: editText /);
    expect(err.message).not.toContain(VALUE);
    expect(await text()).toBe("Hello world");
  });

  it.each([
    ["keyboard", false],
    ["bound secret", true],
  ])("an end anchor in a non-editable child: refused (%s path)", async (_path, bound) => {
    await page().setContent(NON_EDITABLE_END);
    const err = await refusal(edit({}, bound));
    expect(err.code).toBe("E_EDIT_NOT_APPLIED");
    expect(await text()).not.toContain(VALUE);
  });

  it("a rejected insert of text already in the editor is still refused (counts, not presence)", async () => {
    await page().setContent(`<div id="ed" contenteditable="true" onbeforeinput="event.preventDefault()">say ${VALUE} twice</div>`);
    const err = await refusal(edit({ anchor: { quote: "twice" }, action: "insertAfter" }));
    expect(err.code).toBe("E_EDIT_NOT_APPLIED");
  });

  it("a rejected replace and a rejected deletion are refused", async () => {
    await page().setContent(REJECTS);
    expect((await refusal(edit({ anchor: { quote: "world" }, action: "replace", value: "there" }))).code).toBe("E_EDIT_NOT_APPLIED");
    expect((await refusal(edit({ anchor: { quote: "world" }, action: "replace", value: "" }))).code).toBe("E_EDIT_NOT_APPLIED");
  });

  it.each([
    ["keyboard", false],
    ["bound secret", true],
  ])("controls: a plain editor takes insert, replace and delete (%s path)", async (_path, bound) => {
    await page().setContent(`<div id="ed" contenteditable="true">Hello world</div>`);
    await edit({}, bound);
    expect(await text()).toBe(`Hello world${VALUE}`);
    await edit({ anchor: { quote: "world" }, action: "replace", value: "there" }, bound);
    expect(await text()).toBe(`Hello there${VALUE}`);
    await edit({ anchor: { quote: "there" }, action: "replace", value: "" }, bound);
    expect(await text()).toBe(`Hello ${VALUE}`);
    await edit({ anchor: { quote: "Hello" }, action: "insertBefore", value: "Oh, " }, bound);
    expect(await text()).toBe(`Oh, Hello ${VALUE}`);
  });

  it("format: a rejected format is refused; a plain editor takes it", async () => {
    await page().setContent(REJECTS);
    expect((await refusal(edit({ anchor: { quote: "world" }, action: "format", format: "bold", value: undefined }))).code).toBe("E_EDIT_NOT_APPLIED");
    await page().setContent(`<div id="ed" contenteditable="true">Hello world</div>`);
    await edit({ anchor: { quote: "world" }, action: "format", format: "bold", value: undefined });
    expect(await ed().evaluate((el) => el.innerHTML)).toMatch(/<(b|strong)>world<\/(b|strong)>/);
  });

  it("control: replacing a quote with the same text is not a refusal", async () => {
    await page().setContent(`<div id="ed" contenteditable="true">Hello world</div>`);
    await edit({ anchor: { quote: "world" }, action: "replace", value: "world" });
    expect(await text()).toBe("Hello world");
  });

  it("control: an editor that applies input from beforeinput in a microtask takes the edit", async () => {
    await page().setContent(MICROTASK_MODEL);
    await edit({});
    expect(await text()).toBe(`Hello world${VALUE}`);
  });
});
