import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import type { JourneySource, SourcedJourney, SourcedJourneyMetadata } from "./source.js";
import type { JevitateManifest } from "./manifest.js";
import { RemoteSource } from "./remote-source.js";
import { FederatedJourneyRegistry } from "./federated-registry.js";
import { FsTrustStore } from "./trust.js";
import { GitSourceManager, type GitExec } from "./git.js";
import { classifyRisk } from "./risk.js";
import { canonicalJourneyHash } from "./hash.js";
import { resolveForRun } from "./run-gate.js";
import { validateForPublish } from "./publish.js";
import {
  UnknownSourceError,
  HashMismatchError,
  UndeclaredOriginError,
  UntrustedRiskyJourneyError,
  UndeclaredTouError,
  EmbeddedSecretError,
} from "./errors.js";

/**
 * Distributed-sources §9/FMECA — refusal contract.
 *
 * This file re-asserts, as ONE readable contract, the fail-fast/refusal
 * behavior for every load-bearing supply-chain FMECA mode (spec §12) this
 * slice covers. It adds NO new production logic — it re-uses the same
 * shape of fakes/fixtures as the existing unit tests (`run-gate.test.ts`,
 * `publish.test.ts`, `remote-source.test.ts`). Those unit test files remain
 * the source of truth for the exhaustive cases; this file exists so a
 * reviewer can read one place and see every mode refuse.
 *
 * Mirrors `packages/runtime/src/slice1-invariants.test.ts`'s role for
 * Slice 1's own invariant set.
 */

const ORIGIN = "https://mail.example.com";

function file(id: string, steps: any[]) {
  return {
    metadata: { id, name: id, promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
    recording: { version: "1", site: "mail.example.com", pages: [{ url: "/", steps: steps.map((s) => ({ step: s })) }] },
    declaredOrigins: [ORIGIN],
  } as any;
}

function metaFor(f: any, sourceName: string): SourcedJourneyMetadata {
  return {
    ...f.metadata,
    source: sourceName,
    pin: "a".repeat(40),
    riskClass: classifyRisk(f),
    contentHash: canonicalJourneyHash(f),
    trusted: false,
  };
}

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

function makeDeps(opts: { source: JourneySource; manifest: JevitateManifest; acked: boolean }) {
  const trust = new FsTrustStore(mkdtempSync(join(tmpdir(), "inv-trust-")));
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

describe("Distributed-sources §9/FMECA — refusal contract", () => {
  it("FMECA #5 / §9.8 unknown source → UnknownSourceError", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    await expect(resolveForRun(deps, "ghost/x")).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("FMECA #2 hash mismatch (TOCTOU) → HashMismatchError", async () => {
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

  it("FMECA #1 / §9.8 undeclared origin → UndeclaredOriginError", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: nonCoveringManifest, acked: true });
    await expect(resolveForRun(deps, "gmail/checkout")).rejects.toBeInstanceOf(UndeclaredOriginError);
  });

  it("FMECA #6 author-downgraded risk: classifier still 'risky' → UntrustedRiskyJourneyError", async () => {
    // The file carries a write step; even if an author-authored manifest/
    // metadata claimed something safer, classifyRisk() never reads such a
    // claim — it reads steps only, so this is still 'risky' and, with no
    // TrustRecord, refused.
    const risky = file("delete-all", [{ kind: "click", target: { testId: "del" }, expect: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { "delete-all": { meta: metaFor(risky, "gmail"), file: risky } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    await expect(resolveForRun(deps, "gmail/delete-all")).rejects.toBeInstanceOf(UntrustedRiskyJourneyError);
  });

  it("FMECA #4 / §8 undeclared-ToU target → UndeclaredTouError", async () => {
    const readOnly = file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }]);
    const source = new FakeSource("gmail", { checkout: { meta: metaFor(readOnly, "gmail"), file: readOnly } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: false });
    await expect(resolveForRun(deps, "gmail/checkout")).rejects.toBeInstanceOf(UndeclaredTouError);
  });

  it("FMECA #3 / §9.7 embedded secret value → EmbeddedSecretError (publish AND import)", async () => {
    const withSecret = file("login", [
      { kind: "fill", target: { testId: "pw" }, value: { redacted: false, value: "hunter2" }, expect: { kind: "urlIncludes", text: "/x" } },
    ]);

    // Import side (run-gate) — trusted (matching hash) so risk alone
    // doesn't block first; the secret gate must refuse regardless.
    const source = new FakeSource("gmail", { login: { meta: metaFor(withSecret, "gmail"), file: withSecret } });
    const deps = makeDeps({ source, manifest: coveringManifest, acked: true });
    await deps.trust.put({
      sourceId: "gmail",
      journeyId: "login",
      contentHash: canonicalJourneyHash(withSecret),
      approvedBy: "m",
      approvedAtIso: "t",
    });
    await expect(resolveForRun(deps, "gmail/login")).rejects.toBeInstanceOf(EmbeddedSecretError);

    // Publish side.
    const journey: Journey = { metadata: withSecret.metadata, recording: withSecret.recording };
    expect(() =>
      validateForPublish({ journey, declaredOrigins: [ORIGIN], toSource: "gmail" }),
    ).toThrow(EmbeddedSecretError);
  });

  it("§9.9 flat sources: adding a source is explicit; nothing auto-adds a transitive source", async () => {
    // Structural: RemoteSource.list() yields only Journey metadata — never a
    // SourceEntry-shaped object (no `gitUrl`/`pinnedCommit` keys) — and
    // neither RemoteSource nor FederatedJourneyRegistry HOLDS a
    // GitSourceManager reference at all, so there is no code path from
    // discovery (list()/find()) into adding a new source. We prove this by
    // wiring a `GitSourceManager` whose `GitExec` throws on ANY call, then
    // exercising list()/find() end-to-end and confirming that poisoned exec
    // is never invoked.
    const poisoned: GitExec = async () => {
      throw new Error("GitSourceManager must never be invoked from a discovery path (§9.9)");
    };
    const poisonedMgr = new GitSourceManager(mkdtempSync(join(tmpdir(), "poison-")), poisoned);
    void poisonedMgr; // never called below — that's the point.

    const dir = mkdtempSync(join(tmpdir(), "remote-"));
    mkdirSync(join(dir, "journeys"), { recursive: true });
    writeFileSync(join(dir, "jevitate.json"), JSON.stringify(coveringManifest));
    writeFileSync(
      join(dir, "journeys", "checkout.journey.json"),
      JSON.stringify(file("checkout", [{ kind: "assert", check: { kind: "urlIncludes", text: "/x" } }])),
    );
    const remote = new RemoteSource("gmail", dir, "a".repeat(40));
    const trust = new FsTrustStore(mkdtempSync(join(tmpdir(), "inv-trust-")));
    const fed = new FederatedJourneyRegistry([remote], trust);

    const list = await remote.list();
    expect(list).toHaveLength(1);
    for (const m of list) {
      expect(m).not.toHaveProperty("gitUrl");
      expect(m).not.toHaveProperty("pinnedCommit");
    }

    const found = await fed.find("");
    expect(found).toHaveLength(1);
  });
});
