import type { Command } from "commander";
import {
  envCredentialStore,
  FEATURE_KEYS,
  requireKeys,
  MissingCredentialError,
  collectMissingKeys,
  FakeGenerationGateway,
  OpenRouterGenerationGateway,
  GEN_TASKS,
  type CredentialKey,
  type Feature,
  type SecureKeyIO,
  type GenerationPort,
  type GenTaskKind,
  type CatalogModel,
  type ModelConstraints,
  type OpenRouterCall,
} from "@jevitate/ai-core";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import type { CliDeps } from "./program.js";
import { resolveDataDir } from "./data-dir.js";

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
}

const DEFAULT_CATALOG: CatalogModel[] = [
  { id: "openai/gpt-4o-mini", promptUsdPer1k: 0.15, completionUsdPer1k: 0.6, regions: [], latencyClass: "fast", capabilities: [] },
];
const DEFAULT_CONSTRAINTS: ModelConstraints = { requiredCapabilities: [] };

const FEATURES: Feature[] = ["generation", "judgment"];

/**
 * A tiny write gate: forwards to `output` while unmuted, drops everything
 * while muted. Exported so the actual "does the key get echoed" decision is
 * directly unit-testable, independent of readline/TTY simulation (per-
 * keystroke echo can't be faithfully exercised outside a real terminal in a
 * non-interactive test runner).
 */
export function createMutableEcho(output: NodeJS.WritableStream): {
  write: (chunk: string) => void;
  mute: () => void;
  unmute: () => void;
} {
  let muted = false;
  return {
    write: (chunk: string) => {
      if (!muted) output.write(chunk);
    },
    mute: () => {
      muted = true;
    },
    unmute: () => {
      muted = false;
    },
  };
}

function realSecureIO(): SecureKeyIO {
  return {
    async promptSecret(message: string): Promise<string> {
      const readline = await import("node:readline");
      return new Promise<string>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const echo = createMutableEcho(process.stdout);
        // Node's core readline has no public masked-input option. Routing
        // every write readline would otherwise make through this output
        // stream's internal hook through our own mute-able gate is the
        // documented workaround for suppressing per-keystroke terminal echo
        // (Node readline FAQ) — genuinely hides the typed key, matching
        // `collectMissingKeys`'s "input hidden" prompt copy. Muted only for
        // the duration of this single prompt; the model never sees the
        // typed value either way (out-of-band, host-only).
        (rl as unknown as { _writeToOutput: (chunk: string) => void })._writeToOutput = (chunk: string) =>
          echo.write(chunk);
        echo.write(`${message} `);
        echo.mute();
        rl.question("", (answer) => {
          echo.unmute();
          rl.close();
          process.stdout.write("\n");
          resolve(answer);
        });
      });
    },
    async persist(key: CredentialKey, value: string): Promise<void> {
      const { mkdir, writeFile, readFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      // D8: prefer ~/.jevitate/credentials.json; fall back to a pre-existing
      // ~/.doit/credentials.json so a pre-rename user's saved key isn't
      // orphaned (and isn't split across two files going forward).
      const path = resolveDataDir(["credentials.json"]);
      await mkdir(dirname(path), { recursive: true });
      let existing: Record<string, string> = {};
      try {
        existing = JSON.parse(await readFile(path, "utf8"));
      } catch {
        // no existing file yet — start fresh
      }
      existing[key] = value;
      await writeFile(path, JSON.stringify(existing, null, 2), { mode: 0o600 });
    },
  };
}

/** Lazily imports `ai` + `@openrouter/ai-sdk-provider` so the CLI builds and
 *  runs `--json`/fake paths without either package resolvable. The key is
 *  placed ONLY in the `Authorization` header, never in `body`/`prompt`. */
async function realOpenRouterCall(): Promise<OpenRouterCall> {
  const { generateObject } = await import("ai");
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  return async ({ model, schema, body, authHeader }) => {
    const openrouter = createOpenRouter({ headers: { Authorization: authHeader } });
    const start = Date.now();
    const { object } = await generateObject({
      model: openrouter(model),
      schema,
      prompt: JSON.stringify(body),
    });
    return { object, latencyMs: Date.now() - start };
  };
}

function buildStore(ai: AiCliDeps | undefined) {
  return envCredentialStore(ai?.env ?? process.env, ai?.localConfig ?? {});
}

export function registerAiCommands(program: Command, deps: CliDeps): void {
  const ai = program.command("ai");

  ai.command("status")
    .option("--json", "emit a JSON envelope")
    .action(function (this: Command) {
      const { json } = this.opts<{ json?: boolean }>();
      const store = buildStore(deps.ai);
      const data: Record<Feature, { required: CredentialKey[]; missing: CredentialKey[] }> =
        {} as Record<Feature, { required: CredentialKey[]; missing: CredentialKey[] }>;
      for (const feature of FEATURES) {
        const required = [...FEATURE_KEYS[feature]];
        const missing = required.filter((k) => !store.detect(k));
        data[feature] = { required, missing };
      }
      const envelope = ok(data);
      if (json) {
        emitJsonLine(program, envelope);
      } else {
        const out = program.configureOutput().writeOut;
        for (const feature of FEATURES) {
          const { missing } = data[feature];
          out?.(`${feature}: ${missing.length === 0 ? "ready" : `missing ${missing.join(", ")}`}\n`);
        }
        process.exitCode = 0;
      }
    });

  ai.command("setup <feature>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, feature: string) {
      const { json } = this.opts<{ json?: boolean }>();
      if (feature !== "generation" && feature !== "judgment") {
        emitJsonLine(program, fail("E_INVALID_FEATURE", `unknown feature '${feature}' — expected 'generation' or 'judgment'`));
        return;
      }
      try {
        const store = buildStore(deps.ai);
        const io = deps.ai?.secureIO ?? realSecureIO();
        const collected = await collectMissingKeys(feature, store, io);
        const envelope = ok({ feature, collected });
        if (json) {
          emitJsonLine(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`collected: ${collected.join(", ") || "(nothing missing)"}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJsonLine(program, fail("E_AI_SETUP", String(err instanceof Error ? err.message : err)));
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
        if (deps.ai?.gateway) {
          gateway = deps.ai.gateway;
        } else if (real) {
          requireKeys("generation", store); // fail-closed before any wiring
          gateway = new OpenRouterGenerationGateway({
            store,
            catalog: deps.ai?.catalog ?? DEFAULT_CATALOG,
            constraints: deps.ai?.constraints ?? DEFAULT_CONSTRAINTS,
            call: await realOpenRouterCall(),
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
        const result = await gateway.generate(task as GenTaskKind, parsedInput as never);
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
  for (const key of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"] as const) {
    const value = store.read(key);
    if (value) out = out.split(value).join("***REDACTED***");
  }
  return out;
}

function emitJsonLine(program: Command, envelope: JsonEnvelope<unknown>): void {
  const writeOut = program.configureOutput().writeOut;
  writeOut?.(`${JSON.stringify(envelope)}\n`);
  process.exitCode = envelope.ok ? 0 : 1;
}
