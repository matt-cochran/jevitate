import type { Control, Snapshot } from "./snapshot.js";
import { fieldMatches, type FieldMatcher, type FieldMatcherKey } from "./secret-fields.js";

/**
 * Type fixtures (#281): bind a FILE's exact contents to a field, typed by code — never paraphrased
 * by the model. A goal that quotes the text to import ("… Click here to learn more about reminders
 * …") was typed as the model's paraphrase with its paragraph breaks lost; `--secret-field` was the
 * only exact-typing mechanism (and it redacts the Recording). `--type-fixture
 * 'label=Paste your text=./fixtures/newsletter.txt'`:
 *
 *  - when the loop chooses `type` on a matching control, code types the file's contents VERBATIM —
 *    line breaks kept, no generated-text cap, no value generator call;
 *  - the model sees the control as bound (`«fixture:newsletter.txt»`), never the contents, so the
 *    choice head stays small and nothing is paraphrased back;
 *  - the Recording keeps the typed text (a Journey replays it exactly), unless the contents hold a
 *    registered run secret: then the fill is `{ redacted: true }` like a bound secret, and every
 *    other seam (transcript, history) scrubs the secret as always.
 *
 * The file is read by the caller (the CLI, which checks it exists and is text; MCP confines its
 * path like every other file argument); this module never touches the file system.
 */

export interface TypeFixture {
  /** The descriptor as given (`label=Body`). */
  readonly descriptor: string;
  readonly matcher: FieldMatcher;
  /** The file's base name: the placeholder the model sees. */
  readonly name: string;
  /** The exact text code types. */
  readonly text: string;
}

export class TypeFixtureSpecError extends Error {
  readonly code = "E_EXPLORE_ARGS";
  constructor(message: string) {
    super(message);
    this.name = "TypeFixtureSpecError";
  }
}

const MATCHER_KEYS: ReadonlySet<string> = new Set<FieldMatcherKey>(["label", "testId", "type", "id", "name"]);

/**
 * Parses `<label|testId|type|id|name>=<value>=<file>` (the file after the LAST `=`). Returns the
 * descriptor and the file path; the caller reads the file.
 */
export function parseTypeFixtureSpec(spec: string): { readonly descriptor: string; readonly matcher: FieldMatcher; readonly path: string } {
  const eq = spec.indexOf("=");
  const last = spec.lastIndexOf("=");
  const key = eq === -1 ? "" : spec.slice(0, eq).trim();
  const value = eq === -1 || last <= eq ? "" : spec.slice(eq + 1, last).trim();
  const path = last <= eq ? "" : spec.slice(last + 1).trim();
  if (!MATCHER_KEYS.has(key) || value === "" || path === "") {
    throw new TypeFixtureSpecError(
      "--type-fixture expects '<label|testId|type|id|name>=<value>=<file>' (e.g. 'label=Paste your text=./fixtures/newsletter.txt')",
    );
  }
  return { descriptor: `${key}=${value}`, matcher: { key: key as FieldMatcherKey, value }, path };
}

/** The only form of a type fixture a model (or the history) sees. */
export function typeFixturePlaceholder(f: TypeFixture): string {
  return `«fixture:${f.name}»`;
}

/** The fixture bound to a control (the first that matches), or null. Only text-entry controls bind. */
export function boundTypeFixture(c: Control, fixtures: readonly TypeFixture[] | undefined): TypeFixture | null {
  if (fixtures === undefined || fixtures.length === 0) return null;
  if (c.tag !== "input" && c.tag !== "textarea" && c.role !== "textbox") return null;
  return fixtures.find((f) => fieldMatches(f.matcher, c)) ?? null;
}

/** The snapshot the model sees: a bound control says code types the fixture (never its contents). */
export function markTypeFixtures(snap: Snapshot, fixtures: readonly TypeFixture[] | undefined): Snapshot {
  if (fixtures === undefined || fixtures.length === 0) return snap;
  let changed = false;
  const controls = snap.controls.map((c) => {
    const f = boundTypeFixture(c, fixtures);
    if (f === null) return c;
    changed = true;
    return { ...c, summary: `${c.summary} (bound: ${typeFixturePlaceholder(f)} — choose \`type\` on it; code types the file's exact text)` };
  });
  return changed ? { ...snap, controls } : snap;
}

/** The mission-context line naming the bound fields (placeholders only). */
export function typeFixtureContext(fixtures: readonly TypeFixture[] | undefined): string | null {
  if (fixtures === undefined || fixtures.length === 0) return null;
  const list = fixtures.map((f) => `${f.descriptor} → ${typeFixturePlaceholder(f)}`).join("; ");
  return `fixture fields are typed by code with a file's exact text: choose \`type\` on the bound field and code types it verbatim (${list})`;
}
