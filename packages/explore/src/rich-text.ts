import type { Page } from "playwright";
import type { GenerationPort } from "@jevitate/ai-core";
import { descriptorToLocator } from "@jevitate/recorder";
import { textEditProblem, type TextEdit } from "@jevitate/recording";
import type { Control } from "./snapshot.js";
import { redactContext, redactText, redactUrl } from "./redact.js";

/**
 * The goal loop's `edit_text` op (#148): an edit INSIDE a rich-text (`contenteditable`) control.
 *
 * The model (`text.edit` generation) proposes the edit — an action, a VERBATIM quote of the
 * element's current text, the text to type, or a format. Code then decides whether it may run:
 *  - the quote must occur in the element's current text EXACTLY once (whitespace-collapsed) — a
 *    missing quote is refused, never degraded to replacing the whole element; a repeated one is
 *    ambiguous and refused too;
 *  - neither the quote nor the typed text may contain a registered secret (a `--secret-field` value
 *    is never typed into a contenteditable through an edit);
 *  - the parts must fit together (`textEditProblem`).
 * The accepted edit is performed by the same page function Recording replay uses
 * (`applyTextEdit`), so the recorded anchor replays deterministically.
 */

/** Bound on the element text shown to the generator, and on the text an edit may type. */
export const EDIT_TEXT_CONTEXT_CHARS = 4_000;
export const EDIT_TEXT_MAX_CHARS = 500;

export type PlannedEdit = { readonly edit: TextEdit } | { readonly refused: string };

/** Whitespace runs collapsed, as the page function sees the element's text. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** How many times `quote` occurs in `text` (both whitespace-collapsed; overlapping matches count). */
export function occurrences(text: string, quote: string): number {
  const t = collapse(text);
  const q = collapse(quote);
  if (q.trim() === "") return 0;
  let n = 0;
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) n += 1;
  return n;
}

/**
 * Code's gate on a proposed edit (pure): the reason it is refused, or the edit to perform. Never
 * repairs a bad proposal into something else.
 */
export function validateTextEdit(
  proposal: { action: TextEdit["action"] | null; quote: string | null; text: string | null; format: TextEdit["format"] | null },
  currentText: string,
  secrets: readonly string[],
): PlannedEdit {
  if (proposal.action === null) return { refused: "no edit proposed" };
  const quote = proposal.quote ?? "";
  if (quote.trim() === "") return { refused: "the edit names no quote to anchor on (fail-closed)" };
  if (redactText(quote, secrets) !== quote || (proposal.text !== null && redactText(proposal.text, secrets) !== proposal.text)) {
    return { refused: "the edit contains a registered secret (never typed into rich text)" };
  }
  const n = occurrences(currentText, quote);
  if (n === 0) return { refused: `quote ${JSON.stringify(quote.slice(0, 80))} is not in the element's text (fail-closed)` };
  if (n > 1) return { refused: `quote ${JSON.stringify(quote.slice(0, 80))} occurs ${n} times in the element's text (ambiguous)` };
  const edit: TextEdit = {
    anchor: { quote },
    action: proposal.action,
    ...(proposal.action === "format" || proposal.text === null ? {} : { value: proposal.text }),
    ...(proposal.action === "format" && proposal.format !== null ? { format: proposal.format } : {}),
  };
  const problem = textEditProblem({ anchor: edit.anchor, action: edit.action, format: edit.format, hasValue: edit.value !== undefined });
  if (problem !== null) return { refused: problem };
  if ((edit.value ?? "").length > EDIT_TEXT_MAX_CHARS) return { refused: `the edit types more than ${EDIT_TEXT_MAX_CHARS} characters` };
  return { edit };
}

/** The rich-text control's current text (`innerText`), or null when it cannot be read. */
export async function readEditableText(page: Page, control: Control): Promise<string | null> {
  return descriptorToLocator(page, control.descriptor)
    .innerText({ timeout: 2_000 })
    .then(
      (t) => t,
      () => null,
    );
}

/**
 * Asks the generator for ONE edit inside `control` and validates it by code. A generator failure
 * propagates (the loop records it like any unavailable value).
 */
export async function planTextEdit(
  gen: GenerationPort,
  input: {
    readonly goal: string;
    readonly control: Control;
    readonly currentText: string;
    readonly history: readonly string[];
    readonly secrets: readonly string[];
  },
): Promise<PlannedEdit> {
  const secrets = input.secrets;
  const { output } = await gen.generate("text.edit", {
    goal: redactContext(input.goal, secrets),
    fieldLabel: redactContext((input.control.name || input.control.summary).slice(0, 200), secrets),
    currentText: redactContext(input.currentText, secrets).slice(0, EDIT_TEXT_CONTEXT_CHARS),
    history: input.history.map((h) => redactContext(redactUrl(h), secrets)),
  });
  return validateTextEdit(output, input.currentText, secrets);
}
