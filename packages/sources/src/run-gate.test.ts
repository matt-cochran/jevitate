import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JourneySource, SourcedJourney, SourcedJourneyMetadata } from "./source.js";
import type { SharedJourneyFile, JevitateManifest } from "./manifest.js";
import { FederatedJourneyRegistry } from "./federated-registry.js";
import { FsTrustStore } from "./trust.js";
import { classifyRisk } from "./risk.js";
import { canonicalJourneyHash } from "./hash.js";
import { resolveForRun } from "./run-gate.js";
import {
  UnknownSourceError,
  HashMismatchError,
  UntrustedRiskyJourneyError,
  UndeclaredOriginError,
  UndeclaredTouError,
  EmbeddedSecretError,
} from "./errors.js";

const ORIGIN = "https://mail.example.com";

function file(id: string, steps: any[]): SharedJourneyFile {
  return {
    metadata: { id, name: id, promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
    recording: { version: "1", site: "mail.example.com", pages: [{ url: "/", steps: steps.map((s) => ({ step: s })) }] },
    declaredOrigins: [ORIGIN],
  } as SharedJourneyFile;
}

function metaFor(f: SharedJourneyFile, sourceName: string): SourcedJourneyMetadata {
  return {
    ...f.metadata,
    source: sourceName,
    pin: "a".repeat(40),
    riskClass: classifyRisk(f),
    contentHash: canonicalJourneyHash(f),
    trusted: false,
  };
}

/** A minimal, fully-controllable `JourneySource` fixture keyed by id. */
class FakeSource implements JourneySource {
  constructor(
    readonly name: string,
    private readonly journeys: Record<string, SourcedJourney>,
  ) {}
  async list(): Promise<SourcedJourneyMetadata[]> {
    return Object.values(this.journeys).map((j) => j.meta);
  }
  async get(id: string): Promise<SourcedJourney | null> {
    return this.journeys[id] ?? null;
  }
}

const coveringManifest: JevitateManifest = {
  version: 1,
  source: "jevitate-gmail",
  sites: [{ origin: ORIGIN, automationPolicy: "allowed", touBasis: `${ORIGIN}/tos` }],
};

const nonCoveringManifest: JevitateManifest = {
  version: 1,
  source: "jevitate-gmail",
  sites: [{ origin: "https://other.example.com", automationPolicy: "allowed", touBasis: "https://other.example.com/tos" }],
};

function makeDeps(opts: {
  source: JourneySource;
  manifest: JevitateManifest;
  acked: boolean;
  trustDir?: string;
}) {
  const trust = new FsTrustStore(opts.trustDir ?? mkdtempSync(join(tmpdir(), "rg-trust-")));
  const fed = new FederatedJourneyRegistry([opts.source], trust);
  return {
    fed,
    trust,
    manifestFor: async () => opts.manifest,
    ackFor: async () =>
      opts.acked
        ? { sourceName: opts.source.name, gitUrl: "https://github.com/x/jevitate-gmail", origins: [ORIGIN], ackedBy: "m", ackedAtIso: "t" }
        : null,
  };
}

describe("resolveForRun — §9.8 run-gate", () => {
  it("refuses an unknown source", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    await expect(resolveForRun(deps, "ghost/x")).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("refuses an unknown id within a known source", async () => {
    const source = new FakeSource("gmail", {});
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    await expect(resolveForRun(deps, "gmail/nope")).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("refuses on content-hash mismatch (TOCTOU)", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    await deps.trust.put({
      sourceId: "gmail",
      journeyId: "checkout",
      contentHash: "sha256:" + "0".repeat(64),
      approvedBy: "m",
      approvedAtIso: "t",
    });
    await expect(resolveForRun(deps, "gmail/checkout")).rejects.toBeInstanceOf(HashMismatchError);
  });

  it("refuses a risky Journey with no TrustRecord", async () => {
    const risky = file("delete-all", [{ kind: "click", target: { testId: "del" }, expect: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { "delete-all": { meta: metaFor(risky, "gmail"), file: risky } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    await expect(resolveForRun(deps, "gmail/delete-all")).rejects.toBeInstanceOf(UntrustedRiskyJourneyError);
  });

  it("refuses a Journey with an undeclared origin", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: nonCoveringManifest, acked: true });
    await expect(resolveForRun(deps, "gmail/checkout")).rejects.toBeInstanceOf(UndeclaredOriginError);
  });

  it("refuses when ToU is undeclared/unacked", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: false });
    await expect(resolveForRun(deps, "gmail/checkout")).rejects.toBeInstanceOf(UndeclaredTouError);
  });

  it("refuses an embedded/materialized secret value even when trusted", async () => {
    const withSecret = file("login", [
      { kind: "fill", target: { testId: "pw" }, value: { redacted: false, value: "hunter2" }, expect: { kind: "urlIncludes", text: "/x" } },
    ]);
    const source = new FakeSource("gmail", { login: { meta: metaFor(withSecret, "gmail"), file: withSecret } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    // Mark it trusted (matching current content hash) so the risk gate
    // doesn't block first — the secret gate must refuse REGARDLESS of trust.
    await deps.trust.put({
      sourceId: "gmail",
      journeyId: "login",
      contentHash: canonicalJourneyHash(withSecret),
      approvedBy: "m",
      approvedAtIso: "t",
    });
    await expect(resolveForRun(deps, "gmail/login")).rejects.toBeInstanceOf(EmbeddedSecretError);
  });

  it("resolves a read-only in-origin Journey under source trust (happy path)", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    const resolved = await resolveForRun(deps, "gmail/checkout");
    expect(resolved.metadata.id).toBe("checkout");
  });
});
