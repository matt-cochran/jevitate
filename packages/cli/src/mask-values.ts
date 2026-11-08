import { domainToASCII } from "node:url";

/**
 * `text` with every value in it replaced, whatever its case, longest value first. A host reaches here
 * lower-cased and in punycode, as `URL` has it, so a value is looked for in that form too.
 */
export function maskValues(text: string, values: readonly string[], mask: string): string {
  const forms = values.flatMap((v) => (v === "" ? [] : [v, domainToASCII(v)])).filter((f) => f !== "");
  return [...new Set(forms)]
    .sort((a, b) => b.length - a.length)
    .reduce((out, form) => out.split(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")).join(mask), text);
}
