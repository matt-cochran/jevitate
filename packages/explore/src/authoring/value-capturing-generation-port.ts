import type { GenerationPort, GenTaskKind, GenInput, GenerationResult } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import { flattenBaseFillSteps } from "@jevitate/recording";

/**
 * Decorates a `GenerationPort`, recording each `generate()` call's textual
 * result in call order. Assumption (see plan header): `@jevitate/explore`'s
 * `fill.ts`/`FillHelper` calls `generate()` exactly once per `fill`/`select`
 * step it executes, in the same left-to-right order those steps end up in the
 * emitted `Recording` — so the Nth captured value corresponds to the Nth
 * fill/select step of `flattenBaseFillSteps(recording)`.
 */
export class ValueCapturingGenerationPort implements GenerationPort {
  private readonly captured: string[] = [];

  constructor(private readonly inner: GenerationPort) {}

  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    const result = await this.inner.generate(kind, input);
    const text = extractText(result.output);
    if (text !== undefined) this.captured.push(text);
    return result;
  }

  capturedValues(recording: Recording): Map<string, string> {
    const fillSteps = flattenBaseFillSteps(recording);
    if (fillSteps.length !== this.captured.length) {
      throw new Error(
        `ValueCapturingGenerationPort: recorded ${this.captured.length} generate() call(s) but the recording has ${fillSteps.length} fill/select step(s) — cannot correlate values 1:1`,
      );
    }
    const values = new Map<string, string>();
    fillSteps.forEach(({ ref }, i) => values.set(`${ref.page}:${ref.step}`, this.captured[i]));
    return values;
  }
}

function extractText(output: unknown): string | undefined {
  if (output && typeof output === "object" && "text" in output) {
    const text = (output as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}
