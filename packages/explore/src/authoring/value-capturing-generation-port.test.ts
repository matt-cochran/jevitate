import { expect, test } from "vitest";
import type { GenerationPort, GenTaskKind, GenInput, GenerationResult } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import { ValueCapturingGenerationPort } from "./value-capturing-generation-port.js";

function fakeInner(values: string[]): GenerationPort {
  let i = 0;
  return {
    async generate<K extends GenTaskKind>(_kind: K, _input: GenInput<K>): Promise<GenerationResult<K>> {
      return { output: { text: values[i++] }, provenance: { model: "fake", tookMs: 0 } } as unknown as GenerationResult<K>;
    },
  };
}

const recording: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [
    {
      url: "/search",
      steps: [
        { step: { kind: "navigate", url: "/search", expect: { kind: "visible", target: { testId: "box" } } } },
        { step: { kind: "fill", target: { testId: "q" }, value: { redacted: true, length: 5 }, expect: { kind: "visible", target: { testId: "results" } } } },
        { step: { kind: "select", target: { testId: "sort" }, value: { redacted: true, length: 4 }, expect: { kind: "visible", target: { testId: "results" } } } },
      ],
    },
  ],
};

test("captures each generate() call's text and correlates it to the recording's fill/select steps in order", async () => {
  const port = new ValueCapturingGenerationPort(fakeInner(["widgets", "newest"]));
  await port.generate("form.value", {} as never);
  await port.generate("form.value", {} as never);

  const values = port.capturedValues(recording);
  expect(values.get("0:1")).toBe("widgets");
  expect(values.get("0:2")).toBe("newest");
});

test("throws when the number of captured values doesn't match the recording's fill/select step count", async () => {
  const port = new ValueCapturingGenerationPort(fakeInner(["only-one"]));
  await port.generate("form.value", {} as never);
  expect(() => port.capturedValues(recording)).toThrow(/cannot correlate/);
});
