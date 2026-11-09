import { describe, expect, it } from "vitest";
import { secretForms } from "@jevitate/ai-core";
import { encodeUrlParamValue } from "@jevitate/recording";
import { maskCheckpointUrl, restoreCheckpointUrl } from "./journey-run-checkpoint.js";

/**
 * Independent check H2: a hold checkpoint's page address masks a secret in every form it can take in a
 * URL: raw, `encodeURIComponent`, the strict form the navigate step sends (`encodeUrlParamValue`, which
 * also encodes `!'()*`), form encoding (`+` for space), and upper- or lowercase percent-hex.
 */

const SITE = "http://127.0.0.1:3001";
const SECRETS = ["MARKERtok123", "MARKER!tok", "MARKER*tok", "MARKER(tok)", "MARKER'tok", "MARKER tok!", "S3ntinel@Va lue/9Zq+x&y"];
const lower = (v: string): string => v.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const formEncoded = (v: string): string => new URLSearchParams([["", v]]).toString().slice(1);
const ENCODINGS: Record<string, (v: string) => string> = {
  raw: (v) => v,
  encodeURIComponent,
  strict: encodeUrlParamValue,
  form: formEncoded,
  "lowercase strict": (v) => lower(encodeUrlParamValue(v)),
  "lowercase form": (v) => lower(formEncoded(v)),
};

function leaks(masked: string, secret: string): boolean {
  let decoded = masked;
  try {
    decoded = decodeURIComponent(masked.replace(/\+/g, " "));
  } catch {
    // a masked address need not decode; its raw text is still checked
  }
  return secretForms(secret).some((f) => masked.includes(f)) || decoded.includes(secret);
}

describe("H2: maskCheckpointUrl masks every URL encoding of a value", () => {
  for (const [how, enc] of Object.entries(ENCODINGS)) {
    it(`a parameter's value, ${how}`, () => {
      for (const secret of SECRETS) {
        const masked = maskCheckpointUrl(`${SITE}/magic?token=${enc(secret)}&next=/home`, { token: secret });
        expect(leaks(masked, secret), `${secret} → ${masked}`).toBe(false);
      }
    });
    it(`a value the run knows (extracted or bound), ${how}`, () => {
      for (const secret of SECRETS) {
        const masked = maskCheckpointUrl(`${SITE}/magic?token=${enc(secret)}&next=/home`, {}, [secret]);
        expect(leaks(masked, secret), `${secret} → ${masked}`).toBe(false);
      }
    });
  }

  it("the strict form the navigate step sends restores to the exact address it was held on", () => {
    for (const secret of SECRETS) {
      const url = `${SITE}/magic?token=${encodeUrlParamValue(secret)}&next=/home`;
      const masked = maskCheckpointUrl(url, { token: secret });
      expect(restoreCheckpointUrl(masked, { token: secret })).toEqual({ url });
    }
  });
});
