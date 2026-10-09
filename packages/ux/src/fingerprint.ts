// fingerprint.ts — #464: a UX finding's identity as the Journeeze catalog bundle carries it
// (journeeze-saas `docs/contract/catalog-bundle-v1.md` §4.4 @ 61f8c92). Jevitate's UX findings
// have no engine fingerprint, so the producer derives one: the first 16 hex characters of SHA-256
// (UTF-8) over `"ux\n" + claim + "\n" + route + "\n" + element`, where `claim` is `producerClaim`
// when the claim is `other`, and `element` is `tflowId` when present, else `controls` joined with
// `\n`. The same claim on the same element of the same route is the same finding, whichever journey
// or run saw it. The reader recomputes it (§9.4), so it is always taken over the EXPORTED fields.
import { createHash } from "node:crypto";
import { routeOf } from "./route.js";

export interface UxFingerprintInput {
  /** The contract's claim (`no-feedback`, …, or `other`). */
  readonly claim: string;
  /** The claim type when `claim` is `other`. */
  readonly producerClaim?: string;
  /** The route TEMPLATE as exported (`/projects/{id}/board`). */
  readonly route: string;
  readonly tflowId?: string;
  readonly controls?: readonly string[];
}

/** The contract's derived UX finding fingerprint (16 lowercase hex). */
export function uxFindingFingerprint(f: UxFingerprintInput): string {
  if (f.claim === "other" && f.producerClaim === undefined) throw new Error("a UX finding whose claim is `other` names its producerClaim");
  const claim = f.claim === "other" ? (f.producerClaim as string) : f.claim;
  const element = f.tflowId ?? (f.controls ?? []).join("\n");
  return createHash("sha256").update(`ux\n${claim}\n${f.route}\n${element}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * A URL, path or `:param` route as the contract's route template: path only (no host, query or
 * fragment), id-like segments templated (`routeOf`), and `:name` written `{name}`.
 */
export function contractRouteTemplate(urlOrRoute: string): string {
  return routeOf(urlOrRoute)
    .split("/")
    .map((seg) => (/^:[A-Za-z][A-Za-z0-9_]{0,63}$/.test(seg) ? `{${seg.slice(1)}}` : seg))
    .join("/");
}
