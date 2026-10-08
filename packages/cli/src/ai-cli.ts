import type { Command } from "commander";
import {
  envCredentialStore,
  ALL_CREDENTIAL_KEYS,
  requireKeys,
  MissingCredentialError,
  FakeGenerationGateway,
  OpenRouterGenerationGateway,
  GEN_TASKS,
  UsageTracker,
  type CredentialKey,
  type Feature,
  type SecureKeyIO,
  type GenerationPort,
  type GenTaskKind,
  type CatalogModel,
  type ModelConstraints,
  type KeyVerdict,
  type VerifyFetch,
  collectKeys,
  verifyKey,
  KEY_PROVIDERS,
  featureKeys,
  jevProviderOverride,
  type JevProvider,
} from "@jevitate/ai-core";
import { JEV_PROVIDER_FLAG_HELP, jevProviderArg } from "./cli-shared.js";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import type { CliDeps } from "./program.js";
import { resolveDataDir } from "./data-dir.js";
import { loadLocalCredentials } from "./credentials-file.js";
import { realOpenRouterCall } from "./openrouter-call.js";
import { resolveUsagePricing } from "./usage-config.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { readMaskedLine } from "./masked-input.js";
import {
  describeFeatureKeys,
  jevRouteReport,
  keySources,
  realVerifyFetch,
  shadowWarnings,
  verificationProblems,
  verifyFeatureKeys,
  type JevRouteReport,
  type KeySourceReport,
  type KeyVerificationReport,
} from "./key-report.js";

/**
 * Additive, optional wiring for `@jevitate/ai-core` threaded through `CliDeps`.
 * Every field is injectable so `ai-cli.test.ts` never touches real env,
 * stdin, or disk — production `buildProgram` calls omit `ai` entirely and
 * get the real-env store + fake generation gateway (never a key by default).
 */
export interface AiCliDeps {
  env?: Record<string, string | undefined>;
  localConfig?: Partial<Record<CredentialKey, string>>;
  secureIO?: SecureKeyIO;
  gateway?: GenerationPort;
  catalog?: CatalogModel[];
  constraints?: ModelConstraints;
  /** #291: the live key check's HTTP GET (tests inject a stub; default: real HTTPS). */
  verifyFetch?: VerifyFetch;
  /** Whether stdin can prompt (a TTY). Default: `process.stdin.isTTY`. Only consulted for the real prompt. */
  isInteractive?: () => boolean;
}

const DEFAULT_CATALOG: CatalogModel[] = [
  { id: "openai/gpt-4o-mini", promptUsdPer1k: 0.15, completionUsdPer1k: 0.6, regions: [], latencyClass: "fast", capabilities: [] },
];
const DEFAULT_CONSTRAINTS: ModelConstraints = { requiredCapabilities: [] };

const FEATURES: Feature[] = ["generation", "judgment"];

export function realSecureIO(): SecureKeyIO {
  return {
    async promptSecret(message: string): Promise<string> {
      // #269: the instructions stay on screen and each typed character shows as `•` (never the
      // character); see masked-input.ts for why readline's echo-muting hack could not do this.
      return readMaskedLine(process.stdin, process.stdout, message);
    },
    async persist(key: CredentialKey, value: string): Promise<void> {
      const { mkdir, writeFile, readFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      // Credentials live at ~/.jevitate/credentials.json (see data-dir.ts).
      const path = resolveDataDir(["credentials.json"]);
      await mkdir(dirname(path), { recursive: true });
      let existing: Record<string, string> = {};
      let raw: string | undefined;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        // Only a MISSING file starts fresh; any other read failure fails closed.
        const missing = typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
        if (!missing) throw err;
      }
      if (raw !== undefined) {
        // Never silently overwrite a file we cannot parse — that would drop the
        // other stored key. Fail closed with an actionable message instead.
        try {
          existing = JSON.parse(raw);
        } catch {
          throw new Error(`${path} is not valid JSON — fix or delete it, then re-run setup`);
        }
      }
      existing[key] = value;
      await writeFile(path, JSON.stringify(existing, null, 2), { mode: 0o600 });
    },
  };
}

function buildStore(ai: AiCliDeps | undefined) {
  return envCredentialStore(ai?.env ?? process.env, ai?.localConfig ?? loadLocalCredentials());
}

/** The env + stored-file inputs the store resolves from — for naming each key's source (#268). */
export function credentialInputs(ai: AiCliDeps | undefined): {
  env: Record<string, string | undefined>;
  localConfig: Partial<Record<CredentialKey, string>>;
} {
  return { env: ai?.env ?? process.env, localConfig: ai?.localConfig ?? loadLocalCredentials() };
}

/** A key the provider refused, or that could not be checked, when entered (#291): never stored. */
export class KeyCheckError extends Error {
  constructor(
    readonly code: "E_AI_KEY_INVALID" | "E_AI_KEY_UNVERIFIED",
    message: string,
  ) {
    super(message);
    this.name = "KeyCheckError";
  }
}

/**
 * The pre-persist check for an entered key (#291): a live auth check; `invalid` / `unreachable`
 * refuse it (nothing stored). Returns the verdict cache the post-entry verification reuses.
 */
export function enteredKeyCheck(fetchFn: VerifyFetch): {
  check: (key: CredentialKey, value: string) => Promise<void>;
  verdicts: Map<CredentialKey, KeyVerdict>;
  entered: Map<CredentialKey, string>;
} {
  const verdicts = new Map<CredentialKey, KeyVerdict>();
  const entered = new Map<CredentialKey, string>();
  return {
    verdicts,
    entered,
    check: async (key, value) => {
      const v = await verifyKey(key, value, fetchFn);
      if (v.status === "invalid") {
        throw new KeyCheckError("E_AI_KEY_INVALID", `${key} was rejected by ${KEY_PROVIDERS[key]} (HTTP ${v.httpStatus}) — not stored; check the key and run setup again`);
      }
      if (v.status === "unreachable") {
        throw new KeyCheckError(
          "E_AI_KEY_UNVERIFIED",
          `${key} could not be verified with ${KEY_PROVIDERS[key]} (${v.reason}) — not stored; retry when online, or pass --no-verify to store it unverified`,
        );
      }
      verdicts.set(key, v);
      entered.set(key, value);
    },
  };
}

export interface FeatureKeyStatus {
  required: CredentialKey[];
  missing: CredentialKey[];
  /** #268: where each key comes from (names and sources only). */
  sources: KeySourceReport[];
  /** #291: the live check per key (absent with --no-verify). */
  verification?: KeyVerificationReport[];
  /** #429 (judgment only): the Jev route judgment will use — provider, key, model, why; null when no key resolves one. */
  route?: JevRouteReport | null;
}

export function registerAiCommands(program: Command, deps: CliDeps): void {
  const ai = program.command("ai").description("check or configure the model gateway credentials jevitate's AI features need");

  ai.command("status")
    .description("which keys each AI feature uses, where each comes from (env or ~/.jevitate/credentials.json), and whether the provider accepts it (a live auth check; never prints a key)")
    .option("--no-verify", "skip the live auth check (offline / CI): report presence and source only")
    .option("--jev-provider <provider>", "report judgment as it would run with this Jev provider: typesafe or openrouter (default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set)", jevProviderArg)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { json, verify, jevProvider: flag } = this.opts<{ json?: boolean; verify: boolean; jevProvider?: JevProvider }>();
      const store = buildStore(deps.ai);
      const { env, localConfig } = credentialInputs(deps.ai);
      const fetchFn = deps.ai?.verifyFetch ?? realVerifyFetch;
      let jevProvider: JevProvider | undefined;
      try {
        jevProvider = jevProviderOverride(env, flag);
      } catch (err) {
        emitJsonOrRefusal(program, fail("E_INVALID_ARGS", err instanceof Error ? err.message : String(err)), 2);
        return;
      }
      const data = {} as Record<Feature, FeatureKeyStatus>;
      for (const feature of FEATURES) {
        // #429: judgment needs EITHER Jev key — `required` names the key its route uses (both when none is set).
        const required = featureKeys(feature, store, jevProvider);
        const missing = required.filter((k) => !store.detect(k));
        const sources = keySources(feature, env, localConfig, jevProvider);
        data[feature] = {
          required,
          missing,
          sources,
          ...(verify ? { verification: await verifyFeatureKeys(feature, store, fetchFn, undefined, jevProvider) } : {}),
          ...(feature === "judgment" ? { route: jevRouteReport(store, env, jevProvider) } : {}),
        };
      }
      // A key the provider refuses (or that could not be checked) is not "ready": exit 2, never 0.
      const all = FEATURES.flatMap((f) => data[f].verification ?? []);
      const problems = verificationProblems(all);
      const exitCode = problems.invalid.length + problems.unreachable.length > 0 ? 2 : 0;
      const envelope = ok(data);
      if (json) {
        emitJsonOrRefusal(program, envelope, exitCode);
      } else {
        const out = program.configureOutput().writeOut;
        for (const feature of FEATURES) out?.(`${describeFeatureKeys(feature, data[feature].sources, data[feature].verification, data[feature].route)}\n`);
        if (problems.unreachable.length > 0) out?.("could not reach a provider to verify a key — retry when online, or pass --no-verify to skip the check\n");
        process.exitCode = exitCode;
      }
    });

  ai.command("setup <feature>")
    .description("enter (masked) and store the keys a feature needs in ~/.jevitate/credentials.json (0600); each key is verified with its provider before it is stored")
    .option("--replace", "prompt for a new value even when a key is already stored (rotate / replace it)")
    .option("--no-verify", "store the entered key without the live auth check (offline / CI)")
    .option("--jev-provider <provider>", "judgment only: which Jev key to set up — typesafe (TYPESAFE_API_KEY, the default) or openrouter (OPENROUTER_API_KEY: Jev through OpenRouter)", jevProviderArg)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, feature: string) {
      const { json, replace, verify, jevProvider: flag } = this.opts<{ json?: boolean; replace?: boolean; verify: boolean; jevProvider?: JevProvider }>();
      if (feature !== "generation" && feature !== "judgment") {
        emitJsonLine(program, fail("E_INVALID_FEATURE", `unknown feature '${feature}' — expected 'generation' or 'judgment'`));
        return;
      }
      if (flag !== undefined && feature !== "judgment") {
        emitJsonLine(program, fail("E_INVALID_ARGS", "--jev-provider applies to `ai setup judgment` only"));
        return;
      }
      try {
        const store = buildStore(deps.ai);
        const { env, localConfig } = credentialInputs(deps.ai);
        // #429: judgment is satisfied by EITHER Jev key; the flag (else JEVITATE_JEV_PROVIDER) picks which one to set up.
        const jevProvider = feature === "judgment" ? jevProviderOverride(env, flag) : undefined;
        const injected = deps.ai?.secureIO;
        const usesNow = featureKeys(feature, store, jevProvider);
        const needsPrompt = replace === true || usesNow.some((k) => !store.detect(k));
        if (injected === undefined && needsPrompt && !(deps.ai?.isInteractive?.() ?? process.stdin.isTTY === true)) {
          const flagHint = flag === undefined ? "" : ` --jev-provider ${flag}`;
          emitJsonLine(
            program,
            fail("E_AI_SETUP", `key entry needs an interactive terminal (stdin is not a TTY) — run \`jevitate ai setup ${feature}${flagHint}${replace === true ? " --replace" : ""}\` in a terminal, or set ${usesNow.join(feature === "judgment" ? " or " : ", ")} in the environment`),
          );
          return;
        }
        const io = injected ?? realSecureIO();
        const fetchFn = deps.ai?.verifyFetch ?? realVerifyFetch;
        const gate = enteredKeyCheck(fetchFn);
        const collected = await collectKeys(feature, store, io, {
          replace: replace === true,
          ...(verify ? { check: gate.check } : {}),
          ...(jevProvider === undefined ? {} : { jevProvider }),
        });
        // What resolves NOW: the stored file plus what was just entered (env still wins).
        const nowLocal = { ...localConfig, ...Object.fromEntries(gate.entered) };
        const nowStore = envCredentialStore(env, nowLocal);
        const reportLocal = verify ? nowLocal : { ...localConfig, ...Object.fromEntries(collected.map((k) => [k, "set"])) };
        const sources = keySources(feature, env, reportLocal, jevProvider);
        const warnings = shadowWarnings(collected, sources);
        // Every key the feature uses is verified, including ones already present ("nothing missing").
        const verification = verify ? await verifyFeatureKeys(feature, nowStore, fetchFn, gate.verdicts, jevProvider) : undefined;
        const route = feature === "judgment" ? jevRouteReport(envCredentialStore(env, reportLocal), env, jevProvider) : undefined;
        const problems = verificationProblems(verification ?? []);
        if (problems.invalid.length > 0 || problems.unreachable.length > 0) {
          const line = describeFeatureKeys(feature, sources, verification, route);
          emitJsonLine(
            program,
            fail(
              problems.invalid.length > 0 ? "E_AI_KEY_INVALID" : "E_AI_KEY_UNVERIFIED",
              problems.invalid.length > 0
                ? `${line}`
                : `${line} — retry when online, or pass --no-verify to skip the check`,
            ),
          );
          return;
        }
        const envelope = ok({
          feature,
          collected,
          sources,
          ...(verification === undefined ? {} : { verification }),
          ...(route === undefined ? {} : { route }),
          ...(warnings.length === 0 ? {} : { warnings }),
        });
        if (json) {
          emitJsonLine(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          out?.(`collected: ${collected.join(", ") || "(nothing missing)"}\n`);
          out?.(`${describeFeatureKeys(feature, sources, verification, route)}\n`);
          // #429: say how to set up the other Jev key, so both routes are discoverable from setup.
          if (feature === "judgment" && route !== undefined && route !== null && flag === undefined) {
            const other = route.provider === "typesafe" ? "openrouter" : "typesafe";
            out?.(`judgment can also use ${other === "openrouter" ? "an OpenRouter key (Jev through OpenRouter)" : "a TypeSafe key"}: \`jevitate ai setup judgment --jev-provider ${other}\`\n`);
          }
          for (const w of warnings) out?.(`warning: ${w}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof KeyCheckError) emitJsonLine(program, fail(err.code, err.message));
        else emitJsonLine(program, fail("E_AI_SETUP", String(err instanceof Error ? err.message : err)));
      }
    });

  ai.command("generate <task>")
    .requiredOption("--input <json>", "task input as a JSON string")
    .option("--real", "use the real OpenRouter adapter (requires OPENROUTER_API_KEY)", false)
    .option("--fake", "explicitly opt into the deterministic fake gateway (no key required)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, task: string) {
      const { input, real, fake, json } = this.opts<{ input: string; real?: boolean; fake?: boolean; json?: boolean }>();
      if (!(task in GEN_TASKS)) {
        emitJsonLine(program, fail("E_UNKNOWN_TASK", `unknown generation task '${task}'`));
        return;
      }
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(input);
      } catch (err) {
        emitJsonLine(program, fail("E_INVALID_INPUT", String(err instanceof Error ? err.message : err)));
        return;
      }
      const store = buildStore(deps.ai);
      try {
        let gateway: GenerationPort;
        // #163: a live call's usage and cost ride on the result (the fake/injected paths make none).
        let usage: UsageTracker | undefined;
        if (deps.ai?.gateway) {
          gateway = deps.ai.gateway;
        } else if (real) {
          requireKeys("generation", store); // fail-closed before any wiring
          gateway = new OpenRouterGenerationGateway({
            store,
            catalog: deps.ai?.catalog ?? DEFAULT_CATALOG,
            constraints: deps.ai?.constraints ?? DEFAULT_CONSTRAINTS,
            call: await realOpenRouterCall((usage = new UsageTracker(resolveUsagePricing(deps.ai?.env ?? process.env)))),
          });
        } else if (fake) {
          gateway = new FakeGenerationGateway();
        } else {
          // No explicit choice made. Silently falling back to the fake
          // gateway here would be a footgun: a user who forgot `--real` (or
          // never ran `ai setup`) would get a fake, made-up answer disclosed
          // only via `provenance.adapter`, easy to miss. Fail closed instead.
          const hasKey = store.detect("OPENROUTER_API_KEY");
          emitJsonLine(
            program,
            fail(
              "E_AI_SETUP_REQUIRED",
              hasKey
                ? "no gateway selected — pass --real to use the configured OPENROUTER_API_KEY, or --fake to explicitly use the deterministic fake gateway"
                : "no gateway selected and no OPENROUTER_API_KEY configured — run `ai setup generation` then pass --real, or pass --fake to explicitly use the deterministic fake gateway",
            ),
          );
          return;
        }
        const generated = await gateway.generate(task as GenTaskKind, parsedInput as never);
        const result = usage === undefined ? generated : { ...generated, usage: usage.snapshot() };
        const envelope = ok(result);
        if (json) {
          emitJsonLine(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof MissingCredentialError) {
          emitJsonLine(program, fail("E_MISSING_CREDENTIAL", err.message));
        } else {
          // Sanitize: an SDK/provider error can echo request internals
          // (headers, body) verbatim in its `.message`, which could contain
          // the key. Never surface raw provider error text in the CLI
          // envelope — log a redacted line for host-side diagnosis instead,
          // and emit a generic, key-free message in the envelope itself.
          const raw = err instanceof Error ? err.message : String(err);
          process.stderr.write(`ai generate: provider error (redacted): ${redactCredentials(raw, store)}\n`);
          emitJsonLine(program, fail("E_AI_GENERATE", "generation failed — see host logs for details"));
        }
      }
    });
}

/** Replaces any configured credential VALUE found in `message` with a
 *  placeholder. Used only for the diagnostic line written to stderr; the
 *  JSON envelope itself never carries provider error text at all. */
function redactCredentials(message: string, store: { read(k: CredentialKey): string | undefined }): string {
  let out = message;
  for (const key of ALL_CREDENTIAL_KEYS) {
    const value = store.read(key);
    if (value) out = out.split(value).join("***REDACTED***");
  }
  return out;
}

/** The envelope (success, or a refusal with --json); a refusal without --json is a human stderr line (#218). */
function emitJsonLine(program: Command, envelope: JsonEnvelope<unknown>): void {
  emitJsonOrRefusal(program, envelope);
}
