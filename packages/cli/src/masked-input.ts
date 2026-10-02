/**
 * #269 — masked key entry. The previous prompt muted readline's echo by hooking its private
 * `_writeToOutput`, but readline's line refresh still moved the cursor and cleared the screen below
 * it on every keystroke: the instructions printed before the prompt vanished as soon as the user
 * typed ("flash off too fast to read"), and nothing showed that input was being received.
 *
 * This reader never clears anything: the instructions stay on their own line, and each typed (or
 * pasted) character is echoed as `•` — never the character itself. Backspace erases one mark,
 * Ctrl-U erases all, Enter finishes, Ctrl-C / Ctrl-D (on an empty entry) cancel. Without a TTY
 * (piped input) it reads one line and echoes nothing. The value is only ever returned to the
 * caller; it is never written to `output`.
 */

export const MASK_CHAR = "•";

export interface MaskedInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** Key entry was cancelled (Ctrl-C, Ctrl-D, or the input ended): nothing was entered. */
export class KeyEntryCancelledError extends Error {
  constructor() {
    super("key entry cancelled — nothing was stored");
    this.name = "KeyEntryCancelledError";
  }
}

export function readMaskedLine(input: MaskedInput, output: NodeJS.WritableStream, message: string): Promise<string> {
  const raw = input.isTTY === true && typeof input.setRawMode === "function";
  output.write(`${message}\n> `);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let done = false;
    const finish = (err: Error | null): void => {
      if (done) return;
      done = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (err === null) resolve(value);
      else reject(err);
    };
    const onEnd = (): void => {
      // Piped input that ends without a newline still delivers what it held; an empty one is a cancel.
      if (value.length > 0) finish(null);
      else finish(new KeyEntryCancelledError());
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // An escape sequence (arrow keys, function keys) is navigation, never part of a key.
      if (raw && text.startsWith("\u001b")) return;
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          finish(null);
          return;
        }
        if (!raw) {
          value += ch;
          continue;
        }
        if (ch === "\u0003") {
          finish(new KeyEntryCancelledError());
          return;
        }
        if (ch === "\u0004") {
          if (value.length === 0) finish(new KeyEntryCancelledError());
          else finish(null);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = [...value].slice(0, -1).join("");
            output.write("\b \b");
          }
          continue;
        }
        if (ch === "\u0015") {
          output.write("\b \b".repeat([...value].length));
          value = "";
          continue;
        }
        if (ch < " ") continue; // other control characters
        value += ch;
        output.write(MASK_CHAR);
      }
    };
    if (raw) input.setRawMode?.(true);
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });
}
