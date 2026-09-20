import { inspect } from "node:util";

/**
 * Wraps a fetched secret plaintext so it can be threaded from a
 * `SecretManagerPort` to the one place allowed to read it (a browser fill)
 * without ever being accidentally logged, JSON-serialized, or interpolated
 * into a string. §9a invariant #2: "The `Secret` type has no
 * toString/JSON serialization; serializing or logging it throws."
 *
 * `reveal()` is the ONLY way out. Callers must pass its result straight
 * into the browser fill and never assign it to anything that outlives that
 * one statement (no local persisted var, no object literal, no return
 * value, no log line).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): never {
    throw new Error("Secret must not be serialized to a string (toString)");
  }

  toJSON(): never {
    throw new Error("Secret must not be serialized to JSON (toJSON)");
  }

  [inspect.custom](): never {
    throw new Error("Secret must not be logged/inspected (util.inspect)");
  }
}
