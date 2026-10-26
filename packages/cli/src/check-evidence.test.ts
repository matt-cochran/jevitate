import { describe, expect, it } from "vitest";
import { createEvidenceManifest, evidenceArtifactsReason, evidenceKey, reuseDecision, sha256 } from "./check-evidence.js";

const input = {
  app: { build: "abc", target: "staging", origins: ["https://app.example"] },
  suite: { name: "release", policyHash: "sha256:policy", changedRoutes: ["/checkout/**"] },
  inputs: { journeys: { checkout: "sha256:journey" }, fixtures: "sha256:fixtures", parameters: "sha256:params", invariants: "sha256:invariants", goals: "sha256:goals", missions: "sha256:missions" },
} as const;

describe("#704 evidence manifest", () => {
  it("is content-addressed independent of input key order", () => {
    expect(evidenceKey(input)).toBe(evidenceKey({ ...input, inputs: { ...input.inputs, journeys: { checkout: "sha256:journey" } } }));
  });

  it("reuses only matching successful untampered evidence", () => {
    const manifest = createEvidenceManifest(input, { "result.json": "sha256:result" });
    expect(reuseDecision(input, manifest).decision).toBe("skip");
    expect(reuseDecision({ ...input, app: { ...input.app, build: "def" } }, manifest)).toMatchObject({ decision: "run", reasons: ["evidence-key-mismatch"] });
    expect(reuseDecision(input, { ...manifest, contentDigest: "sha256:forged" })).toMatchObject({ decision: "run", reasons: ["evidence-tampered"] });
  });

  it("refuses missing or changed result artifacts before reuse", () => {
    const manifest = createEvidenceManifest(input, { "result.json": `sha256:${sha256("original")}` });
    expect(evidenceArtifactsReason(manifest, (path) => (path === "result.json" ? "original" : ""))).toBeUndefined();
    expect(evidenceArtifactsReason(manifest, () => "changed")).toBe("evidence-artifact-tampered");
    expect(evidenceArtifactsReason(manifest, () => { throw new Error("ENOENT"); })).toBe("evidence-artifact-missing");
  });
});
