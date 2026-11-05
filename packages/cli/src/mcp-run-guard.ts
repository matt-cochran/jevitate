import type { BrowserContext, Locator, Request, Route, WebSocketRoute } from "playwright";
import { readControlIdentity, SafetyPolicy, type SafetyVerdict } from "@jevitate/explore";
import { ReplayRefusal, type ReplayActionGuard } from "@jevitate/interpreter";
import type { BrowserSession } from "@jevitate/playwright";
import type { RecordedStep } from "@jevitate/recording";
import { inMcpInvocation, noteMcpRefusal } from "./approval-provenance.js";
import { environmentsFilePath, loadEnvironmentsFile, type ResolvedJourneyEnvironment } from "./environments.js";
import { EXIT_CODES } from "./exit-codes.js";
import { loadTargetsFile, type McpRunAllowances, type TargetConfig } from "./target-config.js";

/**
 * #789 — the floor under an MCP-driven replay, until run modes exist (#792). By default such a run:
 *  - never clicks what a mission never clicks: `SafetyPolicy`, on the live element's name, as a mission
 *    reads it (session-ending, destructive and paid controls, the target's `safety.deny`/`safety.paid`);
 *  - never lets a write leave the browser for an origin outside the run's allowlist: the same test
 *    `journey run` reports them by (`offAllowlistWriteOrigin`), here enforced at the BrowserContext, so
 *    popups and form posts are covered, plus WebSocket frames;
 *  - never replays on an environment flagged `production: true`.
 *
 * A refusal ends the run (`RunGuardRefusedError`): it is not a failed step, is never healed or retried,
 * and names the setting that lifts it. The settings are `targets.json[<origin>].mcpRun`, a file only a
 * person writes: no MCP tool has an argument for them, and `confineMcpPath` refuses that file to every
 * path argument. Outside an MCP invocation nothing here applies (`journey run` is unchanged).
 *
 * A refusal never carries page text or a parameter value: it names the rule and the rule's matched
 * words, never the control's name, and masks a parameter value in an origin.
 *
 * Known limit: Playwright's route sees only the first request of a redirect chain. A write an allowed
 * origin redirects (307/308) off the allowlist has left the browser by then; it is still detected, and
 * ends the run the same way.
 */

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origins of an allowlist (entries that do not parse are dropped: they allow nothing). */
export function allowedOriginSet(allowedOrigins: readonly string[]): ReadonlySet<string> {
  return new Set(
    allowedOrigins.flatMap((o) => {
      try {
        return [new URL(o).origin];
      } catch {
        return [];
      }
    }),
  );
}

/** #485: the origin of an http(s) write (any method but GET/HEAD/OPTIONS) outside `allowed`, else undefined. */
export function offAllowlistWriteOrigin(method: string, url: string, allowed: ReadonlySet<string>): string | undefined {
  if (READ_METHODS.has(method.toUpperCase())) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return allowed.has(u.origin) ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

export type RunGuardCode = "E_RUN_REFUSED_DESTRUCTIVE" | "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE" | "E_RUN_REFUSED_PRODUCTION" | "E_RUN_GUARD_CONFIG";

/** #789: the typed end of a refused MCP run. Not a failed step and not a pass; running it again answers the same. */
export class RunGuardRefusedError extends ReplayRefusal {
  override readonly name = "RunGuardRefusedError";
  readonly retryable = false;
  constructor(
    readonly code: RunGuardCode,
    message: string,
    /** The setting that lifts it (or, for a target's own `safety.deny`, the one that imposes it). */
    readonly setting: string,
    readonly extra: { readonly rule?: string; readonly at?: number } = {},
  ) {
    super(message);
  }
}

/** #789: the MCP error body of a refusal: `outcome: refused`, never a pass, never to be retried. */
export function runGuardRefusalBody(err: RunGuardRefusedError): Record<string, unknown> {
  return { error: "refused", outcome: "refused", code: err.code, setting: err.setting, ...err.extra, message: err.message, retryable: false, exitCode: EXIT_CODES.inconclusive };
}

const DO_NOT_RETRY = "This is not a failed run to retry: it is refused the same way until a person changes that setting.";

/** One origin's entry of the targets file (the keys may be written with a trailing slash). */
function targetForOrigin(targets: Readonly<Record<string, TargetConfig>>, origin: string): TargetConfig | undefined {
  for (const [key, target] of Object.entries(targets)) {
    try {
      if (new URL(key).origin === origin) return target;
    } catch {
      // A key that is no URL is no origin's entry.
    }
  }
  return undefined;
}

/** True when this origin is any declared environment's flagged `production: true` (a `baseUrl` naming it counts as `env` naming it). */
function declaredProduction(origin: string, environmentsFile: string | null): boolean {
  if (environmentsFile === null) return false;
  return Object.values(loadEnvironmentsFile(environmentsFile)).some((e) => {
    if (e.production !== true) return false;
    return [e.baseUrl, ...Object.values(e.origins ?? {})].some((o) => allowedOriginSet([o]).has(origin));
  });
}

export interface McpRunGuardRequest {
  /** The Journey's site, on its environment. */
  readonly site: string;
  readonly allowedOrigins: readonly string[];
  readonly environment?: ResolvedJourneyEnvironment | undefined;
  /** `targets.json` (default: `~/.jevitate/targets.json`). */
  readonly targetsFile?: string | undefined;
  /** `.jevitate/environments.json` (default: the project's). */
  readonly environmentsFile?: string | undefined;
}

/**
 * The guard of one MCP-driven replay, decided before any fixture or browser: undefined outside an MCP
 * invocation. Refuses here a production environment and a config it cannot read (fail closed).
 */
export function prepareMcpRunGuard(req: McpRunGuardRequest): McpRunGuard | undefined {
  if (!inMcpInvocation()) return undefined;
  const origin = allowedOriginSet([req.site]).values().next().value ?? req.site;
  let target: TargetConfig | undefined;
  let production: boolean;
  try {
    target = targetForOrigin(req.targetsFile === undefined ? loadTargetsFile() : loadTargetsFile(req.targetsFile), origin);
    production = req.environment?.production === true || declaredProduction(origin, req.environmentsFile ?? environmentsFilePath());
  } catch (err) {
    throw refused(new RunGuardRefusedError("E_RUN_GUARD_CONFIG", `an MCP run could not read what allows it on ${origin}, so it does not run: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, "targets.json / environments.json"));
  }
  const allowances = target?.mcpRun ?? {};
  if (production && allowances.allowProduction !== true) {
    const setting = `targets.json["${origin}"].mcpRun.allowProduction`;
    throw refused(new RunGuardRefusedError("E_RUN_REFUSED_PRODUCTION", `${origin} is flagged production: true, and an MCP run does not replay there by default. A person allows it with ${setting}: true. ${DO_NOT_RETRY}`, setting));
  }
  return new McpRunGuard(origin, req.allowedOrigins, allowances, target);
}

function refused(err: RunGuardRefusedError): RunGuardRefusedError {
  noteMcpRefusal(err);
  return err;
}

/** The nearest element a click on `locator` activates, when it is not the element itself. */
const INTERACTIVE_ANCESTOR = 'xpath=ancestor-or-self::*[self::button or self::a or self::summary or self::input or @role="button" or @role="link" or @role="menuitem" or @role="tab"][1]';
/** A key press that activates the focused control (`Enter`, `Control+Enter`, `Space`). */
const ACTIVATING_KEY = /(?:^|\+)(?:Enter|NumpadEnter|Space| )$/i;
/** A key press in a text field types or submits; the field's name says nothing about what it does. */
const TEXT_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "combobox"]);
/** A key press that submits the focused field's form (HTML's implicit submission). */
const SUBMITTING_KEY = /(?:^|\+)(?:Enter|NumpadEnter)$/i;

/**
 * BROWSER CODE. The button that Enter in this field clicks: its form's default button, the first submit
 * button in tree order, a `form=` associated one included. Null where Enter clicks no such button: not a
 * field that submits (a textarea, a button, which activates itself), no form, or a disabled default
 * button, which HTML says submits nothing. A form with no submit button can still submit, with no
 * control to judge; it is not refused here.
 */
function defaultButtonOf(field: Element): Element | null {
  const selfActivating = field instanceof HTMLInputElement && ["submit", "image", "button", "reset"].includes(field.type);
  if ((!(field instanceof HTMLInputElement) && !(field instanceof HTMLSelectElement)) || selfActivating || field.form === null) return null;
  const { form } = field;
  const button = [...document.querySelectorAll("button, input")].find(
    (e) => (e instanceof HTMLButtonElement && e.form === form && e.type === "submit") || (e instanceof HTMLInputElement && e.form === form && (e.type === "submit" || e.type === "image")),
  );
  return button === undefined || button.matches(":disabled") ? null : button;
}

export class McpRunGuard implements ReplayActionGuard {
  readonly #origin: string;
  readonly #allowed: ReadonlySet<string>;
  readonly #policy: SafetyPolicy;
  #values: readonly string[] = [];
  #refusal: RunGuardRefusedError | undefined;
  #step: number | undefined;
  #onRefusedWrite: ((request: Request) => void) | undefined;
  #dispose: (() => Promise<void>) | undefined;
  #disposed = false;

  constructor(origin: string, allowedOrigins: readonly string[], allowances: McpRunAllowances, target: TargetConfig | undefined) {
    this.#origin = origin;
    this.#allowed = allowedOriginSet([...allowedOrigins, ...(allowances.allowOffAllowlistWrites ?? [])]);
    // The target's own refusals hold; exploration's `safety.allowDestructive` is NOT this switch.
    const { deny, paid, allowControl } = target?.safety ?? {};
    this.#policy = new SafetyPolicy({
      ...(deny === undefined ? {} : { deny }),
      ...(paid === undefined ? {} : { paid }),
      ...(allowControl === undefined ? {} : { allowControl }),
      ...(allowances.allowDestructive === true ? { allowDestructive: true } : {}),
    });
  }

  /** Arms the write guard on the session's context, before the run's first request. A test double's page, with no context, has nothing to arm. */
  async arm(session: BrowserSession, params: Readonly<Record<string, string>>, onRefusedWrite?: (request: Request) => void): Promise<void> {
    this.#values = Object.values(params).filter((v) => v !== "");
    this.#onRefusedWrite = onRefusedWrite;
    const page = session.page as { context?: () => BrowserContext };
    if (typeof page.context !== "function") return;
    const context = page.context();
    const onRoute = async (route: Route, request: Request): Promise<void> => {
      const off = offAllowlistWriteOrigin(request.method(), request.url(), this.#allowed);
      if (off === undefined) {
        await route.fallback().catch(() => undefined);
        return;
      }
      this.#refuseWrite(off, "");
      this.#onRefusedWrite?.(request);
      await route.abort("blockedbyclient").catch(() => undefined);
    };
    // A route sees only a redirect chain's first request; what it could not stop still ends the run.
    const onRequest = (request: Request): void => {
      if (request.redirectedFrom() === null) return;
      const off = offAllowlistWriteOrigin(request.method(), request.url(), this.#allowed);
      if (off !== undefined) this.#refuseWrite(off, " It came as a redirect from an allowed origin, which a browser cannot be stopped from following, so it may have been sent.");
    };
    const onSocket = (ws: WebSocketRoute): void => {
      if (!this.claimSocket(ws)) ws.connectToServer();
    };
    await context.route("**/*", onRoute);
    await context.routeWebSocket(/.*/, onSocket);
    context.on("request", onRequest);
    this.#dispose = async () => {
      context.off("request", onRequest);
      await context.unroute("**/*", onRoute).catch(() => undefined);
    };
  }

  /**
   * True when the guard took this socket: off the allowlist, it is never connected, and a frame the page
   * sends is the write. Playwright calls only the socket route added last, so another route of the same
   * context (a self-heal run's) asks here first or its socket would pass these frames.
   */
  claimSocket(ws: WebSocketRoute): boolean {
    const off = offAllowlistWriteOrigin("WEBSOCKET", ws.url().replace(/^ws/, "http"), this.#allowed);
    // A socket route outlives `dispose` (it has no unroute): a session a mission goes on using gets its sockets back.
    if (off === undefined || this.#disposed) return false;
    ws.onMessage(() => this.#refuseWrite(off, ""));
    return true;
  }

  #mask(piece: string): string {
    return this.#values.reduce((text, v) => text.split(v).join("[param]"), piece);
  }

  #refuseWrite(off: string, note: string): void {
    if (this.#refusal !== undefined) return;
    const shown = this.#mask(off);
    const setting = `targets.json["${this.#origin}"].mcpRun.allowOffAllowlistWrites`;
    const at = this.#step === undefined ? "" : ` at step ${this.#step + 1}`;
    this.#refusal = refused(
      new RunGuardRefusedError(
        "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE",
        `the page sent a write to ${shown}${at}, outside this run's allowed origins, and an MCP run refuses it by default.${note} A person allows that origin with ${setting}: ["${shown}"]. ${DO_NOT_RETRY}`,
        setting,
        this.#step === undefined ? {} : { at: this.#step + 1 },
      ),
    );
  }

  #refuseControl(verdict: SafetyVerdict, index: number): never {
    const { ruleId, pattern } = verdict.refusal;
    // A target's own `safety.deny` is what refuses it: nothing here lifts it. Its words are the operator's; the control's never appear.
    const denied = ruleId.startsWith("deny:") || ruleId === "builtin:nameless-control";
    const setting = denied ? `targets.json["${this.#origin}"].safety.deny` : `targets.json["${this.#origin}"].mcpRun.allowDestructive`;
    const what = verdict.risk === "session-end" ? "ends the session" : verdict.risk === "destructive" ? "is destructive" : verdict.risk === "paid" ? "may cost money or reach real people" : "is denied by the target";
    const lift = denied ? `The target's ${setting} refuses it; a person changes that.` : `A person allows it for this target with ${setting}: true.`;
    this.#refusal = refused(
      new RunGuardRefusedError(
        "E_RUN_REFUSED_DESTRUCTIVE",
        `step ${index + 1} was not run: its control ${what} (rule ${denied ? ruleId : `${ruleId}, matched ${JSON.stringify(this.#mask(pattern))}`}), and an MCP run refuses it by default. ${lift} ${DO_NOT_RETRY}`,
        setting,
        { rule: ruleId, at: index + 1 },
      ),
    );
    throw this.#refusal;
  }

  #judge(name: string, role: string, recorded: RecordedStep): SafetyVerdict | null {
    const step = recorded.step;
    return this.#policy.refuses({ name, role, descriptor: "target" in step ? step.target : {} } as Parameters<SafetyPolicy["refuses"]>[0]);
  }

  async beforeAction(ctx: { readonly index: number; readonly recorded: RecordedStep; readonly locator: Locator; readonly key?: string }): Promise<void> {
    this.afterStep();
    this.#step = ctx.index;
    if (ctx.key !== undefined && !ACTIVATING_KEY.test(ctx.key)) return;
    const { locator } = ctx;
    if (typeof locator.evaluate !== "function") return; // A test double's locator has no element to read.
    if (ctx.key !== undefined && (await locator.count()) === 0) return; // No element holds focus: the key activates nothing.
    if (ctx.key !== undefined && SUBMITTING_KEY.test(ctx.key)) {
      // What Enter submits is named on the form's default button, whatever the field is called.
      const button = (await locator.evaluateHandle(defaultButtonOf)).asElement();
      if (button !== null) {
        const { name, role } = await readControlIdentity(button);
        const verdict = this.#judge(name, role, ctx.recorded);
        if (verdict !== null) this.#refuseControl(verdict, ctx.index);
      }
    }
    const element = await readControlIdentity(locator);
    if (ctx.key !== undefined && TEXT_ROLES.has(element.role)) return;
    // What a click activates may be an ancestor of what resolved (`<button>Delete <span>…</span></button>`).
    const ancestor = locator.locator(INTERACTIVE_ANCESTOR);
    const named = (await ancestor.count()) === 0 ? [element] : [element, await readControlIdentity(ancestor.first())];
    const label = ctx.recorded.step.label;
    for (const c of [...named, ...(label === undefined ? [] : [{ name: label, role: "" }])]) {
      const verdict = this.#judge(c.name, c.role, ctx.recorded);
      if (verdict !== null) this.#refuseControl(verdict, ctx.index);
    }
  }

  afterStep(): void {
    if (this.#refusal !== undefined) throw this.#refusal;
  }

  /** Throws what ended the run, if anything did since the last step (a write the end state's checks set off). */
  check(): void {
    this.afterStep();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#dispose?.();
    this.#dispose = undefined;
  }
}
