import type { AlignedColumn } from "./align.js";

/**
 * The classification result for one aligned column (Task 5's
 * `AlignedColumn`): what "kind" of thing this position in the flow is,
 * across takes, plus a confidence score and the resolved per-take values
 * that led to it.
 *
 * `"enumeration"`/`enumerationId` are part of the type for forward
 * compatibility with the design's "repeated aligned sub-sequence over
 * sibling nth targets" case — see the module doc below for why this task
 * does NOT implement that detection. `classifyColumns` never emits
 * `"enumeration"`.
 */
export interface ColumnClass {
  kind: "constant" | "variable" | "enumeration" | "noise" | "ambiguous";
  confidence: number; // 0..1
  values: (string | null)[]; // one entry per take, same order as cols[c].cells
  inferredType?: "email" | "number" | "string";
  enumerationId?: string;
}

export interface DiffResult {
  columns: ColumnClass[];
}

/**
 * Classifies each aligned column (Task 5's `AlignedColumn[]`) into
 * constant / variable / noise / ambiguous (enumeration is out of scope —
 * see below), using the per-take AUTHORING values captured for `fill`/
 * `select` steps (Task 1's `AuthoringRecording.values`, one `Map` per
 * take).
 *
 * ## Flat-index derivation (no extra input needed)
 *
 * `values[i]` is keyed by take `i`'s FLAT step index: the stringified
 * 0-based position of a step within `pages.flatMap(p => p.steps)` for that
 * take's original `Recording` — the same flattening convention used by
 * `packages/interpreter/src/interpreter.ts`'s `flatten()` and by Task 5's
 * `alignTraces` (see `align.ts`'s `flattenTake`).
 *
 * `alignTraces` never reorders a single take's own steps — it only
 * interleaves gaps from other takes — so reading take `i`'s non-null cells
 * in column order reproduces that take's original step order exactly. We
 * exploit this: walk `cols` in order while maintaining one running counter
 * per take (`counters[i]`, starting at 0); whenever `cols[col].cells[i]`
 * is non-null, that cell's flat index INTO take `i`'s original sequence is
 * the counter's CURRENT value — read it, then increment. This lets us look
 * up `values[i].get(String(flatIndex))` for every cell without any extra
 * input beyond `cols` and `values`.
 *
 * ## Enumeration — OUT OF SCOPE for this task
 *
 * The design's "a repeated aligned sub-sequence over sibling `nth` targets
 * → enumeration" needs intra-take repetition analysis (detecting that a
 * whole run of columns repeats structurally within a single take against
 * sibling elements) that a straightforward per-column classifier can't
 * expose from `(cols, values)` alone — it's a sequence-level pattern, not
 * a column-level one. `ColumnClass.kind` supports `"enumeration"` /
 * `enumerationId` for forward compatibility (so the type contract is
 * complete for later work), but this implementation never emits it,
 * falling through to constant/variable/noise/ambiguous instead. This is a
 * deliberate scope cut, not an oversight — see Task 6 brief / controller
 * ruling.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function classifyColumns(
  cols: AlignedColumn[],
  values: Map<string, string>[],
): DiffResult {
  const numTakes = values.length;
  const counters = new Array<number>(numTakes).fill(0);

  const columns: ColumnClass[] = cols.map((col) => {
    // Resolve this column's per-take value (or null), while advancing each
    // take's flat-index counter for every non-null cell it has here —
    // this MUST happen for every non-null cell regardless of step kind, so
    // that a later fill/select column's flat index stays correct.
    const resolved: (string | null)[] = col.cells.map((cell, i) => {
      if (cell === null) return null;

      const flatIndex = counters[i];
      counters[i] = flatIndex + 1;

      const isValueBearing = cell.step.kind === "fill" || cell.step.kind === "select";
      if (!isValueBearing) return null;

      return values[i]?.get(String(flatIndex)) ?? null;
    });

    return classifyOne(resolved, numTakes);
  });

  return { columns };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601-ish timestamp: date, optional time-of-day with optional
// fractional seconds and an optional trailing offset/Z.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
// A long (>=20 chars) token built only from hex digits and/or dashes — the
// same spirit as `signature.ts`'s `urlTemplate` id heuristic: real
// natural-language content essentially never consists purely of
// `[0-9a-f-]` at that length, so this catches session ids / hashes /
// ULID-ish tokens without also catching typed prose.
const LONG_HEX_OR_DASH = /^[0-9a-f-]{20,}$/i;
// A long (>=20 chars) run with no whitespace that is highly likely a
// generated token rather than typed content: alphanumeric only (letters +
// digits, no punctuation/spaces) and containing at least one digit (pure
// alphabetic long strings are more likely to be real words/names, so this
// heuristic deliberately excludes those).
const LONG_ALNUM_WITH_DIGIT = /^(?=.*[0-9])[a-z0-9]{20,}$/i;

/**
 * Heuristic "does this look like noise (session id / timestamp / uuid /
 * high-entropy generated token)" check, in the same spirit as
 * `signature.ts`'s `urlTemplate` id heuristic. Not a guarantee — a
 * genuinely long alphanumeric-with-digit typed value would also match, but
 * that's an acceptable false-positive rate for a low-confidence "noise"
 * signal (the low confidence score reflects that uncertainty).
 */
function looksLikeNoise(value: string): boolean {
  return (
    UUID.test(value) ||
    ISO_TIMESTAMP.test(value) ||
    LONG_HEX_OR_DASH.test(value) ||
    LONG_ALNUM_WITH_DIGIT.test(value)
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inferType(presentValues: string[]): "email" | "number" | "string" {
  if (presentValues.every((v) => EMAIL.test(v))) return "email";
  if (presentValues.every((v) => v.trim() !== "" && Number.isFinite(Number(v)))) return "number";
  return "string";
}

const NOISE_CONFIDENCE = 0.2;

function classifyOne(resolved: (string | null)[], numTakes: number): ColumnClass {
  const present = resolved.filter((v): v is string => v !== null);

  // No value dimension at all (non-fill/select column, or fill/select
  // steps with no captured value at every present cell): the structural
  // step itself is present/absent per alignment, but there's nothing to
  // classify on the value axis. Treat as constant, full confidence — no
  // value-based ambiguity exists here by construction.
  if (present.length === 0) {
    return { kind: "constant", confidence: 1.0, values: resolved };
  }

  if (present.some(looksLikeNoise)) {
    return { kind: "noise", confidence: NOISE_CONFIDENCE, values: resolved };
  }

  const distinct = new Set(present);

  // Controller ruling: with only one take total passed to classifyColumns,
  // no corroboration is possible, so a column can never be "variable" —
  // default to "constant" regardless of how many distinct values appear
  // (there can only ever be at most one present value per column here
  // since there's only one take, i.e. one cell, per column).
  if (numTakes <= 1) {
    return { kind: "constant", confidence: 1.0, values: resolved };
  }

  if (distinct.size === 1) {
    // All present values agree. Confidence scales with how many of the
    // takes actually had a value here (fewer gaps => more corroboration
    // of the agreement) — full confidence when every take is present and
    // agrees, scaled down slightly per missing take.
    const completeness = present.length / resolved.length;
    const confidence = 0.8 + 0.2 * completeness; // 0.8..1.0
    return { kind: "constant", confidence, values: resolved };
  }

  // present.length >= 1 and distinct.size >= 2: at least two takes present
  // different values here. "Confident variable" requires >=2 DISTINCT
  // non-noise values among >=2 different takes present — which is exactly
  // this branch, since distinct.size >= 2 implies present.length >= 2.
  const inferredType = inferType(present);
  // Confidence rises with corroborating takes (more present values that
  // support a genuine value-varying column), capped at 1.
  const confidence = Math.min(1, 0.5 + 0.15 * (present.length - 1));
  return { kind: "variable", confidence, values: resolved, inferredType };
}
