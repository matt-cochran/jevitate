import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { KeyEntryCancelledError, MASK_CHAR, readMaskedLine } from "./masked-input.js";

/**
 * #269 — key entry keeps its instructions on screen (nothing is cleared) and shows masked feedback
 * (`•` per character), never the value.
 */
const OR_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const TS_KEY = "ts_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0";

describe("masked key entry (#269)", () => {
  function tty(): PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void; raw: boolean[] } {
    const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void; raw: boolean[] };
    s.isTTY = true;
    s.raw = [];
    s.setRawMode = (m) => void s.raw.push(m);
    return s;
  }
  function sink(): { stream: PassThrough; text: () => string } {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (c) => chunks.push(String(c)));
    return { stream, text: () => chunks.join("") };
  }

  it("keeps the instructions on screen, echoes one mask per character (never the character), handles backspace", async () => {
    const input = tty();
    const out = sink();
    const p = readMaskedLine(input, out.stream, "Enter OPENROUTER_API_KEY — input masked:");
    input.write("sk-or-x");
    input.write("\u007f"); // backspace
    input.write("YZ\r");
    await expect(p).resolves.toBe("sk-or-YZ");
    const shown = out.text();
    expect(shown.startsWith("Enter OPENROUTER_API_KEY — input masked:\n> ")).toBe(true);
    expect(shown).toContain(MASK_CHAR.repeat(7));
    expect(shown).toContain("\b \b");
    expect(shown).not.toContain("sk-or");
    expect(shown).not.toMatch(/\u001b\[/); // never clears the line/screen (the instructions stay)
    expect(input.raw).toEqual([true, false]);
  });

  it("Ctrl-C cancels; a paste arrives masked; piped input reads one line with no echo", async () => {
    const input = tty();
    const p = readMaskedLine(input, sink().stream, "Enter X:");
    input.write("abc\u0003");
    await expect(p).rejects.toBeInstanceOf(KeyEntryCancelledError);

    const pasted = tty();
    const o = sink();
    const q = readMaskedLine(pasted, o.stream, "Enter X:");
    pasted.write(`${OR_KEY}\r`);
    await expect(q).resolves.toBe(OR_KEY);
    expect(o.text()).toContain(MASK_CHAR.repeat(OR_KEY.length));
    expect(o.text()).not.toContain(OR_KEY);

    const piped = new PassThrough();
    const po = sink();
    const r = readMaskedLine(piped, po.stream, "Enter X:");
    piped.write(`${TS_KEY}\n`);
    await expect(r).resolves.toBe(TS_KEY);
    expect(po.text()).not.toContain(TS_KEY);
  });
});
