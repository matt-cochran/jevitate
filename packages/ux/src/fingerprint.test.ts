import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { contractRouteTemplate, uxFindingFingerprint } from "./fingerprint.js";

/**
 * #464: the Journeeze catalog bundle's derived UX fingerprint (catalog-bundle-v1.md §4.4). The
 * golden value is the contract's own full fixture (`full/bundle.json` findings[0]).
 */

const sha16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

describe("uxFindingFingerprint", () => {
  it("matches the contract's full fixture finding", () => {
    expect(uxFindingFingerprint({ claim: "no-feedback", route: "/board", tflowId: "item.verdict.broken", controls: ['button "Broken"'] })).toBe("5b7e448babe54616");
  });

  it("uses the controls joined with a newline when there is no tflowId", () => {
    expect(uxFindingFingerprint({ claim: "blocked-action", route: "/a", controls: ['button "Save"', 'link "Back"'] })).toBe(sha16('ux\nblocked-action\n/a\nbutton "Save"\nlink "Back"'));
  });

  it("prefers the tflowId over the controls", () => {
    expect(uxFindingFingerprint({ claim: "no-feedback", route: "/a", tflowId: "x.save", controls: ['button "Save"'] })).toBe(
      uxFindingFingerprint({ claim: "no-feedback", route: "/a", tflowId: "x.save", controls: ['button "Other"'] }),
    );
  });

  it("hashes the producerClaim when the claim is other", () => {
    expect(uxFindingFingerprint({ claim: "other", producerClaim: "nielsen-4", route: "/a", controls: [] })).toBe(sha16("ux\nnielsen-4\n/a\n"));
  });

  it("refuses `other` without a producerClaim", () => {
    expect(() => uxFindingFingerprint({ claim: "other", route: "/a" })).toThrow(/producerClaim/);
  });
});

describe("contractRouteTemplate", () => {
  it.each([
    ["/board?item=7", "/board"],
    ["https://app.test/projects/42/board#top", "/projects/{id}/board"],
    ["/projects/:id/board", "/projects/{id}/board"],
  ])("templates %s as %s", (input, route) => {
    expect(contractRouteTemplate(input)).toBe(route);
  });
});
