import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { watchEscapedWrites } from "./journey-api.js";

const SAVE = { method: () => "POST", url: () => "http://127.0.0.1:9/api/save?x=1" };
const LINE = "POST /api/save";

/** A block-write's own line sent after its window. Answered means the mutation did not hold. */
describe("a held write answered after the window", () => {
  const watching = (held = true): { context: EventEmitter; escaped: () => string[] } => {
    const context = new EventEmitter();
    return { context, escaped: watchEscapedWrites(context as never, () => (held ? LINE : undefined)) };
  };

  it("counts once its response arrived, though the browser never says it finished", () => {
    const { context, escaped } = watching();
    context.emit("request", SAVE);
    context.emit("response", { request: () => SAVE });
    expect(escaped()).toEqual([LINE]);
  });

  it("does not count while it has no response, or when the guard aborted it", () => {
    const { context, escaped } = watching();
    context.emit("request", SAVE);
    expect(escaped()).toEqual([]);
    context.emit("requestfailed", SAVE);
    expect(escaped()).toEqual([]);
  });

  it("does not count a line that was not held when it was sent", () => {
    const { context, escaped } = watching(false);
    context.emit("request", SAVE);
    context.emit("response", { request: () => SAVE });
    expect(escaped()).toEqual([]);
  });
});
