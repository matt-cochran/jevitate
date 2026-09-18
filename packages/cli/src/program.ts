import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import type { ProfileManager } from "@doit/daemon";
import { SitePolicySchema, simulateTiming, type PlannedStep, type SitePolicy } from "@doit/domain";
import { openDatabase, migrateToLatest, SqliteSitePolicyRepository } from "@doit/storage-sqlite";
import {
  RecordingSchema,
  AuthoringTakeSchema,
  promoteToVariable,
  diffTakes,
  fitInteractionPolicy,
  type Recording,
  type AuthoringRecording,
  type ColumnClass,
} from "@doit/recording";
import { ok, fail, type JsonEnvelope } from "./envelope.js";

export interface CliDeps {
  profiles: ProfileManager;
  dbPath?: string;
}

const DEFAULT_DB_PATH = join(homedir(), ".doit", "db.sqlite");

function resolveDbPath(deps: CliDeps, flag?: string): string {
  return flag ?? deps.dbPath ?? DEFAULT_DB_PATH;
}

function makeClock() {
  return {
    nowIso: () => new Date().toISOString(),
    monotonicMs: () => Date.now(),
  };
}

async function withSitePolicyRepository<T>(
  dbPath: string,
  fn: (repository: SqliteSitePolicyRepository) => Promise<T>
): Promise<T> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    await migrateToLatest(db);
    const repository = new SqliteSitePolicyRepository(db, makeClock());
    return await fn(repository);
  } finally {
    await db.destroy();
  }
}

function isPlannedStep(value: unknown): value is PlannedStep {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string") return false;
  switch (record.kind) {
    case "type":
      return typeof record.text === "string";
    case "click":
    case "navigate":
      return true;
    case "read":
      return typeof record.chars === "number";
    default:
      return false;
  }
}

function parsePlannedScript(raw: string): PlannedStep[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isPlannedStep)) {
    throw new Error("script must be a JSON array of planned steps ({kind, label, ...})");
  }
  return parsed;
}

/**
 * Writes a JSON envelope using the program's CURRENTLY-CONFIGURED output
 * writer (read at call time via `configureOutput()`), so tests that call
 * `program.configureOutput({ writeOut })` after `buildProgram()` still see
 * output routed to their writer. Also sets `process.exitCode` (0 for `ok`,
 * 1 for `fail`) instead of hard-exiting, so `exitOverride()` in tests works.
 */
function emitJson(program: Command, envelope: JsonEnvelope<unknown>): void {
  const writeOut = program.configureOutput().writeOut;
  writeOut?.(`${JSON.stringify(envelope)}\n`);
  process.exitCode = envelope.ok ? 0 : 1;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program.name("brauto").description("Local browser automation platform").version("0.0.0");

  program
    .command("init")
    .option("--json", "emit a JSON envelope")
    .action(function (this: Command) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const envelope = ok({ initialized: true });
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.("brauto initialized\n");
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INIT", String(err)));
      }
    });

  const profile = program.command("profile");

  profile
    .command("create <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const status = await deps.profiles.create(name);
        const envelope = ok(status);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`profile '${status.name}' created at ${status.dir}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_PROFILE_CREATE", String(err)));
      }
    });

  profile
    .command("status <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const status = await deps.profiles.status(name);
        const envelope = ok(status);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `profile '${status.name}': ${status.exists ? "exists" : "missing"} (${status.dir})\n`
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_PROFILE_STATUS", String(err)));
      }
    });

  const site = program.command("site");
  const sitePolicy = site.command("policy");

  sitePolicy
    .command("get <site>")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, json } = this.opts<{ account: string; db?: string; json?: boolean }>();
      try {
        const dbPath = resolveDbPath(deps, db);
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(siteId, account));
        const envelope = ok(policy);
        if (json) {
          emitJson(program, envelope);
        } else {
          if (policy) {
            program.configureOutput().writeOut?.(
              `policy for '${siteId}' (version ${policy.version}): ${JSON.stringify(policy)}\n`
            );
          } else {
            program.configureOutput().writeOut?.(
              `no policy configured for '${siteId}' (account '${account}')\n`
            );
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_POLICY_GET", String(err)));
      }
    });

  sitePolicy
    .command("set <site>")
    .requiredOption("--file <path>", "path to a policy JSON file")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, file, json } = this.opts<{
        account: string;
        db?: string;
        file: string;
        json?: boolean;
      }>();
      let policy: SitePolicy;
      try {
        const raw = await readFile(file, "utf8");
        policy = SitePolicySchema.parse(JSON.parse(raw));
      } catch (err) {
        emitJson(program, fail("E_INVALID_POLICY", String(err)));
        return;
      }
      try {
        const dbPath = resolveDbPath(deps, db);
        await withSitePolicyRepository(dbPath, (repository) => repository.set(siteId, account, policy));
        const envelope = ok({ site: siteId, account, version: policy.version });
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `policy for '${siteId}' (account '${account}') set to version ${policy.version}\n`
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_POLICY_SET", String(err)));
      }
    });

  site
    .command("simulate <site>")
    .requiredOption("--script <path>", "path to a planned-step script JSON file")
    .option("--seed <n>", "deterministic RNG seed", "0")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, script, seed, json } = this.opts<{
        account: string;
        db?: string;
        script: string;
        seed: string;
        json?: boolean;
      }>();
      let plannedScript: PlannedStep[];
      try {
        const raw = await readFile(script, "utf8");
        plannedScript = parsePlannedScript(raw);
      } catch (err) {
        emitJson(program, fail("E_INVALID_SCRIPT", String(err)));
        return;
      }
      const seedNum = Number(seed);
      if (!Number.isFinite(seedNum)) {
        emitJson(program, fail("E_INVALID_SEED", `--seed must be a finite number, got ${JSON.stringify(seed)}`));
        return;
      }
      try {
        const dbPath = resolveDbPath(deps, db);
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(siteId, account));
        const interaction = policy?.interaction ?? {};
        const profile = simulateTiming(interaction, seedNum, plannedScript);
        const envelope = ok(profile);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const step of profile.steps) {
            out?.(`${step.kind} '${step.label}': ${step.delayMs}ms\n`);
          }
          out?.(`totalMs: ${profile.totalMs}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_SIMULATE", String(err)));
      }
    });

  const recording = program.command("recording");

  recording
    .command("promote <file>")
    .requiredOption("--page <n>", "page index")
    .requiredOption("--step <n>", "step index within the page")
    .requiredOption("--var <name>", "variable name to bind")
    .action(async function (this: Command, file: string) {
      const { page, step, var: varName } = this.opts<{ page: string; step: string; var: string }>();
      try {
        const raw = await readFile(file, "utf8");
        const rec: Recording = RecordingSchema.parse(JSON.parse(raw));
        const result = promoteToVariable(rec, { page: Number(page), step: Number(step) }, varName);
        program.configureOutput().writeOut?.(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = 0;
      } catch (err) {
        emitJson(program, fail("E_INVALID_RECORDING", String(err)));
      }
    });

  recording
    .command("diff <takeA> <takeB> [more...]")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, takeA: string, takeB: string, more: string[]) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const files = [takeA, takeB, ...more];
        const takes: AuthoringRecording[] = await Promise.all(
          files.map(async (f) => {
            const raw = await readFile(f, "utf8");
            const parsed = AuthoringTakeSchema.parse(JSON.parse(raw));
            return { recording: parsed.recording, values: new Map(Object.entries(parsed.values)) };
          })
        );
        const diffResult = diffTakes(takes);
        const envelope = ok(diffResult);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          diffResult.columns.forEach((col: ColumnClass, i: number) => {
            const type = col.inferredType ? `, type=${col.inferredType}` : "";
            out?.(
              `column ${i}: ${col.kind} (confidence ${col.confidence.toFixed(2)}${type}) values=${JSON.stringify(col.values)}\n`
            );
          });
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INVALID_TAKE", String(err)));
      }
    });

  recording
    .command("fit <file>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, file: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const raw = await readFile(file, "utf8");
        const rec: Recording = RecordingSchema.parse(JSON.parse(raw));
        const interaction = fitInteractionPolicy(rec);
        const policy: SitePolicy = { version: "1.0.0", interaction };
        if (json) {
          emitJson(program, ok(policy));
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(policy, null, 2)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INVALID_RECORDING", String(err)));
      }
    });

  return program;
}
