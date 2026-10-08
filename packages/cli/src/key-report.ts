import { homedir } from "node:os";
import {
  KEY_PROVIDERS,
  MissingCredentialError,
  credentialProvenance,
  describeVerdict,
  envCredentialStore,
  featureKeys,
  jevRouteModel,
  looksLikeOtherKey,
  resolveJevRoute,
  verifyKey,
  type CredentialKey,
  type CredentialStore,
  type Feature,
  type JevProvider,
  type KeyVerdict,
  type VerifyFetch,
} from "@jevitate/ai-core";
import { credentialsFilePath } from "./credentials-file.js";

/**
 * Key provenance + live verification for `init`, `ai status` and `ai setup` (#268, #291). Names,
 * providers, sources and verdicts only — no function here returns, prints or logs a key value.
 */

/** Where one required key comes from (`--json`: `keys[feature].sources`, additive). */
export interface KeySourceReport {
  readonly key: CredentialKey;
  readonly provider: string;
  readonly source: "env" | "file" | "missing";
  /** The env var the value is read from (the key's own name, or an accepted alias). */
  readonly envVar?: string;
  /** The credentials file (`~/.jevitate/credentials.json`). */
  readonly path?: string;
  /** An env var is set AND the file holds the key: the env value wins (the stored one is unused). */
  readonly shadowsStored?: true;
}

/** One key's live check (`--json`: `verification`, additive). */
export interface KeyVerificationReport {
  readonly key: CredentialKey;
  readonly provider: string;
  readonly status: KeyVerdict["status"];
  readonly httpStatus?: number;
  readonly reason?: string;
  /** The value looks like another provider's key (a key stored in the wrong slot). */
  readonly looksLike?: CredentialKey;
}

/** `~/.jevitate/credentials.json` — the file path with the home directory abbreviated. */
export function displayCredentialsPath(): string {
  const p = credentialsFilePath();
  const home = homedir();
  return home !== "" && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * #429: which Jev route judgment will use (`--json`: `judgment.route`, additive) — the provider,
 * the key it authenticates with, the model it asks for, and why (`override` = `--jev-provider` /
 * `JEVITATE_JEV_PROVIDER`; `precedence` = the TypeSafe key wins when both are set).
 */
export interface JevRouteReport {
  readonly provider: JevProvider;
  readonly key: CredentialKey;
  readonly model: string;
  readonly reason: "override" | "precedence";
}

/** The judgment route, or null when no key resolves one (names only — never a value). */
export function jevRouteReport(store: CredentialStore, env: Record<string, string | undefined>, jevProvider?: JevProvider): JevRouteReport | null {
  try {
    const r = resolveJevRoute(store, jevProvider);
    return { provider: r.provider, key: r.key, model: jevRouteModel(r.provider, env), reason: r.reason };
  } catch (e) {
    if (e instanceof MissingCredentialError) return null;
    throw e;
  }
}

/** `via OpenRouter (model ~typesafe/jev-latest; no TypeSafe key set)` — the route and why (names only). */
export function describeJevRoute(route: JevRouteReport): string {
  const why = route.reason === "override" ? "chosen by --jev-provider / JEVITATE_JEV_PROVIDER" : route.provider === "typesafe" ? "the TypeSafe key is preferred" : "no TypeSafe key set";
  return `via ${route.provider === "openrouter" ? "OpenRouter" : "TypeSafe"} (model ${route.model}; ${why})`;
}

export function keySources(
  feature: Feature,
  env: Record<string, string | undefined>,
  localConfig: Partial<Record<CredentialKey, string>>,
  jevProvider?: JevProvider,
): KeySourceReport[] {
  return featureKeys(feature, envCredentialStore(env, localConfig), jevProvider).map((key) => {
    const p = credentialProvenance(key, env, localConfig);
    const base = { key, provider: p.provider };
    if (p.source.kind === "env") return { ...base, source: "env" as const, envVar: p.source.envVar, ...(p.shadowsStored ? { shadowsStored: true as const } : {}) };
    if (p.source.kind === "file") return { ...base, source: "file" as const, path: displayCredentialsPath() };
    return { ...base, source: "missing" as const };
  });
}

/** The default verifier: one HTTPS GET with the key in the Authorization header. */
export const realVerifyFetch: VerifyFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, signal: init.signal });
  // The body is never read (it may describe the key); only the status decides.
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status };
};

/** Verifies every required key of `feature` (the effective value: env wins). `known` skips a re-check. */
export async function verifyFeatureKeys(
  feature: Feature,
  store: CredentialStore,
  fetchFn: VerifyFetch,
  known: ReadonlyMap<CredentialKey, KeyVerdict> = new Map(),
  jevProvider?: JevProvider,
): Promise<KeyVerificationReport[]> {
  const out: KeyVerificationReport[] = [];
  for (const key of featureKeys(feature, store, jevProvider)) {
    const value = store.read(key);
    const verdict: KeyVerdict = value === undefined ? { status: "missing" } : (known.get(key) ?? (await verifyKey(key, value, fetchFn)));
    const other = value === undefined || verdict.status === "valid" ? null : looksLikeOtherKey(key, value);
    out.push({
      key,
      provider: KEY_PROVIDERS[key],
      status: verdict.status,
      ...(verdict.status === "invalid" ? { httpStatus: verdict.httpStatus } : {}),
      ...(verdict.status === "unreachable" ? { reason: verdict.reason } : {}),
      ...(other === null ? {} : { looksLike: other }),
    });
  }
  return out;
}

function verdictOf(v: KeyVerificationReport): KeyVerdict {
  if (v.status === "invalid") return { status: "invalid", httpStatus: v.httpStatus ?? 0 };
  if (v.status === "unreachable") return { status: "unreachable", reason: v.reason ?? "unknown" };
  return { status: v.status };
}

/** `OPENROUTER_API_KEY (OpenRouter), from env OPENROUTER_API_KEY` / `…, from ~/.jevitate/credentials.json`. */
export function describeSource(s: KeySourceReport): string {
  const name = `${s.key} (${s.provider})`;
  if (s.source === "env") {
    return `${name}, from env ${s.envVar ?? s.key}${s.shadowsStored === true ? ` (overrides the key stored in ${displayCredentialsPath()})` : ""}`;
  }
  if (s.source === "file") return `${name}, from ${s.path ?? displayCredentialsPath()}`;
  return `${name} missing`;
}

/** One verification as a human phrase (never a value). */
export function describeVerification(v: KeyVerificationReport): string {
  const other = v.looksLike === undefined ? "" : KEY_PROVIDERS[v.looksLike];
  const misplaced = v.looksLike === undefined ? "" : ` — looks like ${/^[aeiou]/i.test(other) ? "an" : "a"} ${other} key (${v.looksLike})`;
  return `${describeVerdict(verdictOf(v))}${misplaced}`;
}

/** A feature's key state without its name: `ready — <sources>: <verdicts>` or `missing <names> — …`. */
export function featureKeysBody(
  feature: Feature,
  sources: readonly KeySourceReport[],
  verification: readonly KeyVerificationReport[] | undefined,
  route?: JevRouteReport | null,
): string {
  const missing = sources.filter((s) => s.source === "missing");
  if (feature === "judgment" && missing.length > 1) {
    // #429: judgment is satisfied by EITHER key.
    return (
      `missing ${missing.map((s) => `${s.key} (${s.provider})`).join(" or ")} — set either in the environment, or run ` +
      `\`jevitate ai setup judgment\` (TypeSafe key) / \`jevitate ai setup judgment --jev-provider openrouter\` (OpenRouter key)`
    );
  }
  if (missing.length > 0) {
    return `missing ${missing.map((s) => `${s.key} (${s.provider})`).join(", ")} — set it in the environment or run \`jevitate ai setup ${feature}\``;
  }
  const parts = sources.map((s) => {
    const v = verification?.find((x) => x.key === s.key);
    return `${describeSource(s)}${v === undefined ? "" : `: ${describeVerification(v)}`}`;
  });
  const bad = verification?.filter((v) => v.status === "invalid") ?? [];
  const hint = bad.length > 0 ? ` — replace it: \`jevitate ai setup ${feature} --replace\`` : "";
  const state = bad.length > 0 ? "NOT ready" : verification?.some((v) => v.status === "unreachable") ? "configured (unverified)" : "ready";
  const via = route === undefined || route === null ? "" : ` ${describeJevRoute(route)}`;
  return `${state}${via} — ${parts.join("; ")}${hint}`;
}

/** A feature's whole key line (`ai status`): `generation: ready — OPENROUTER_API_KEY (OpenRouter), from env …: valid`. */
export function describeFeatureKeys(
  feature: Feature,
  sources: readonly KeySourceReport[],
  verification: readonly KeyVerificationReport[] | undefined,
  route?: JevRouteReport | null,
): string {
  return `${feature}: ${featureKeysBody(feature, sources, verification, route)}`;
}

/** Any verification that is not a pass (invalid or unreachable). */
export function verificationProblems(verification: readonly KeyVerificationReport[]): { invalid: KeyVerificationReport[]; unreachable: KeyVerificationReport[] } {
  return {
    invalid: verification.filter((v) => v.status === "invalid"),
    unreachable: verification.filter((v) => v.status === "unreachable"),
  };
}

/** Env vars that shadow a key just stored (the stored value is unused while they are set). */
export function shadowWarnings(collected: readonly CredentialKey[], sources: readonly KeySourceReport[]): string[] {
  return sources
    .filter((s) => collected.includes(s.key) && s.source === "env")
    .map((s) => `env ${s.envVar ?? s.key} is set and overrides the ${s.key} just stored — unset it to use the stored key`);
}
