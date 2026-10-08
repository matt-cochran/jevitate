import { Command } from "commander";
import { redactUrl } from "@jevitate/ai-core";
import { normalizeAllowlist } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { fail, ok } from "./envelope.js";
import { emitCommandResult, type CliDeps } from "./cli-shared.js";
import { positiveIntArg } from "./cli-args.js";
import { loadPersonasFile, MultiRunArgsError, projectPersonas, type Persona } from "./multi-run.js";
import { checkSaveTarget, LoginArgsError, LoginFailedError, loginFromFlags, mintStorageState, type PersonaLogin } from "./persona-login.js";

/**
 * #427 `jevitate login`: mint a persona's Playwright storage state from credentials held in
 * environment variables. The command line (and a personas file) only ever names the variables; the
 * values are read here, typed into the sign-in form on an authorized origin, and never printed,
 * logged or recorded (the login session has no trace, video, HAR or screenshot).
 */

interface LoginFlags {
  persona?: string;
  personas?: string;
  url?: string;
  userEnv?: string;
  passwordEnv?: string;
  userField?: string;
  passwordField?: string;
  submit?: string;
  success?: string;
  save?: string;
  allow: string[];
  timeout?: number;
  json?: boolean;
}

/** What `jevitate login` reports — names and paths only, never a credential. */
export interface LoginResult {
  readonly persona?: string;
  /** Absolute path of the saved storage state (mode 0600). */
  readonly saved: string;
  readonly loginUrl: string;
  /** Where the sign-in ended (token-like query values redacted). */
  readonly landedUrl: string;
  readonly userEnv: string;
  readonly passwordEnv: string;
  readonly warnings: readonly string[];
}

const DEFAULT_TIMEOUT_S = 30;
const PERSONA_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function formatLoginHuman(data: unknown): string {
  const r = data as LoginResult;
  return `signed in${r.persona === undefined ? "" : ` as persona ${r.persona}`} (${r.userEnv}/${r.passwordEnv}) — storage state saved to ${r.saved} (mode 0600)\n`;
}

/** The persona's declared login parameters and session, from `--personas` or the project's `.jevitate/personas.json`. */
function declaredPersona(name: string, personasFile: string | undefined): Persona | undefined {
  const all = personasFile === undefined ? projectPersonas() : loadPersonasFile(personasFile);
  return all.find((p) => p.name === name);
}

export function registerLoginCommand(program: Command, deps: CliDeps): void {
  program
    .command("login")
    .description(
      "#427: sign in as a persona with credentials from environment variables and save its Playwright storage state (mode 0600) — " +
        "the session `explore --storage-state/--persona` starts from. Credentials are never accepted as values, never printed or recorded",
    )
    .option("--persona <name>", "the persona being signed in (names it in the result); with a declared persona (--personas or .jevitate/personas.json) its login parameters and storage state path are the defaults")
    .option("--personas <file>", "personas JSON to read --persona's login parameters from (default: the project's .jevitate/personas.json)")
    .option("--url <loginUrl>", "the sign-in page (must be an authorized origin: its own, or --allow)")
    .option("--user-env <VAR>", "environment variable holding the username (its NAME — the value is read from the environment)")
    .option("--password-env <VAR>", "environment variable holding the password (its NAME — the value is read from the environment)")
    .option("--user-field <field>", "the username field: its label, else a CSS selector (default: found by autocomplete/type/name)")
    .option("--password-field <field>", "the password field: its label, else a CSS selector (default: the visible password input)")
    .option("--submit <name>", "the submit button's accessible name (default: the form's submit button, else Enter)")
    .option("--success <check>", "how a successful sign-in is recognised: urlIncludes:<text> | selector:<css> | text:<text> (default: the page leaves the sign-in form — no login-like URL, no password field)")
    .option("--save <file>", "where to write the storage state (parent directory created; mode 0600; never inside a repo's .jevitate/)")
    .option("--allow <origin>", "an origin credentials may be typed into (repeatable; default: the sign-in page's own) — e.g. an SSO provider", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--timeout <seconds>", `how long each step of the sign-in may take (default ${DEFAULT_TIMEOUT_S})`, positiveIntArg)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<LoginFlags>();
      const emit = (envelope: Parameters<typeof emitCommandResult>[1]): void =>
        emitCommandResult(program, envelope, { json: o.json === true, command: "login", human: formatLoginHuman });
      let login: PersonaLogin;
      let save: string;
      let warnings: string[];
      try {
        if (o.persona !== undefined && !PERSONA_NAME.test(o.persona)) {
          throw new LoginArgsError(`--persona ${JSON.stringify(o.persona)} must be 1-64 of [A-Za-z0-9_.-], starting alphanumeric`);
        }
        const declared = o.persona === undefined ? undefined : declaredPersona(o.persona, o.personas);
        if (o.personas !== undefined && o.persona === undefined) throw new LoginArgsError("--personas reads a declared persona's login parameters: pass --persona <name> too");
        if (o.personas !== undefined && declared === undefined) throw new LoginArgsError(`persona ${o.persona} is not declared in ${o.personas}`);
        const base = declared?.login;
        const url = o.url ?? base?.url;
        const userEnv = o.userEnv ?? base?.userEnv;
        const passwordEnv = o.passwordEnv ?? base?.passwordEnv;
        const target = o.save ?? declared?.storageState;
        const missing = [url === undefined ? "--url" : null, userEnv === undefined ? "--user-env" : null, passwordEnv === undefined ? "--password-env" : null, target === undefined ? "--save" : null].filter(
          (m): m is string => m !== null,
        );
        if (missing.length > 0) {
          throw new LoginArgsError(`missing ${missing.join(", ")}${o.persona === undefined ? "" : ` (persona ${o.persona} declares no login parameters for ${missing.length === 1 ? "it" : "them"})`}`);
        }
        login = loginFromFlags({
          url: url!,
          userEnv: userEnv!,
          passwordEnv: passwordEnv!,
          ...pick("userField", o.userField ?? base?.userField),
          ...pick("passwordField", o.passwordField ?? base?.passwordField),
          ...pick("submit", o.submit ?? base?.submit),
          ...pick("success", o.success ?? base?.success),
        });
        ({ path: save, warnings } = checkSaveTarget(target!, "--save"));
      } catch (err) {
        if (err instanceof LoginArgsError || err instanceof MultiRunArgsError) {
          emit(fail("E_LOGIN_ARGS", err.message));
          return;
        }
        throw err;
      }
      const allowlist = o.allow.length > 0 ? normalizeAllowlist(o.allow) : normalizeAllowlist([login.url]);
      for (const w of warnings) program.configureOutput().writeErr?.(`warning: ${w}\n`);
      try {
        const minted = await mintStorageState({
          login,
          save,
          allowlist,
          env: deps.explore?.env ?? process.env,
          port: (deps.explore?.browserPortFactory ?? (() => new PlaywrightBrowserPort()))(),
          timeoutMs: (o.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
        });
        const result: LoginResult = {
          ...(o.persona === undefined ? {} : { persona: o.persona }),
          saved: minted.saved,
          loginUrl: redactUrl(login.url),
          landedUrl: minted.landedUrl,
          userEnv: login.userEnv,
          passwordEnv: login.passwordEnv,
          warnings,
        };
        emit(ok(result));
      } catch (err) {
        if (err instanceof LoginArgsError) emit(fail("E_LOGIN_ARGS", err.message));
        else if (err instanceof LoginFailedError) emit(fail("E_LOGIN_FAILED", err.message));
        else throw err;
      }
    });
}

function pick<K extends string>(k: K, v: string | undefined): { [P in K]?: string } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: string };
}
