import type { DistParams, InteractionPolicy, TypingModel } from "./interaction-policy.js";
import { gaussian } from "./rng.js";

const SENTENCE_ENDERS = new Set([".", "?", "!"]);

export class Pacer {
  constructor(private readonly rng: () => number) {}

  typingDelays(text: string, m: TypingModel): number[] {
    const base = 1000 / m.charsPerSecond;
    const delays: number[] = new Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      // Pause extras are sampled before the base cadence draw for this
      // character (still one rng-consuming pass per character, in text
      // order, so results stay fully deterministic for a given seed).
      const extra = this.pauseFor(char, m);
      const baseDelay = gaussian(this.rng, {
        mean: base,
        sd: base * m.perKeyJitter,
        min: base * 0.4,
        max: base * 3,
      });
      delays[i] = baseDelay + extra;
    }
    return delays;
  }

  think(m: InteractionPolicy): number {
    return this.sample(m.thinkBeforeActionMs);
  }

  reading(nChars: number, m: InteractionPolicy): number {
    return Math.min(nChars * (m.readingMsPerChar ?? 0), m.maxReadingMs ?? Infinity);
  }

  interInteraction(m: InteractionPolicy): number {
    return this.sample(m.interInteractionMs);
  }

  private pauseFor(char: string, m: TypingModel): number {
    let extra = 0;
    if (char === " ") extra += this.sample(m.wordPauseMs);
    if (SENTENCE_ENDERS.has(char)) extra += this.sample(m.sentencePauseMs);
    if (m.hesitation && this.rng() < m.hesitation.probability) {
      extra += this.sample(m.hesitation.pauseMs);
    }
    return extra;
  }

  private sample(dist: DistParams | undefined): number {
    return dist ? gaussian(this.rng, dist) : 0;
  }
}
