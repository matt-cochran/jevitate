import type { BrowserContext, Locator, Request, Route, WebSocketRoute } from "playwright";
import { readControlIdentity, SafetyPolicy, type SafetyVerdict } from "@jevitate/explore";
import type { DistParams, SitePolicy } from "@jevitate/domain";
import { ReplayRefusal, type ReplayActionGuard } from "@jevitate/interpreter";
import type { BrowserSession } from "@jevitate/playwright";
import type { RecordedStep } from "@jevitate/recording";
import { currentMcpInvocation, inMcpInvocation, noteMcpRefusal, type McpInvocation } from "./approval-provenance.js";
import { maskValues } from "./mask-values.js";
import { environmentsFilePath, loadEnvironmentsFile, type ResolvedJourneyEnvironment } from "./environments.js";
import { EXIT_CODES } from "./exit-codes.js";
import { canonicalOrigin, loadTargetsFile, type McpRunAllowances, type TargetConfig } from "./target-config.js";
import type { RunMode } from "./run-mode.js";
import { resolveRunTarget, testDeclaredOrigins } from "./journey-run-mode-gate.js";

/**
 * #789 — the floor under an MCP-driven replay, until run modes exist (#792). By default such a run:
 *  - never clicks what a mission never clicks: `SafetyPolicy`, on the live element's name, as a mission
 *    reads it (session-ending, destructive and paid controls, the target's `safety.deny`/`safety.paid`);
 *  - never lets a write leave the browser for an origin outside the run's allowlist: the same test
 *    `journey run` reports them by (`offAllowlistWriteOrigin`), here enforced at the BrowserContext, so
 *    popups and form posts are covered, plus WebSocket frames;
 *  - never replays on an environment flagged `production: true`, and never lets a write reach an origin
 *    so flagged, whatever the allowlist says, unless that origin's own `mcpRun.allowProduction` lifts it.
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

/** The origins of an allowlist, in `canonicalOrigin`'s form (entries that do not parse are dropped: they allow nothing). */
export function allowedOriginSet(allowedOrigins: readonly string[]): ReadonlySet<string> {
  return new Set(allowedOrigins.flatMap((o) => canonicalOrigin(o) ?? []));
}

/** #485: the origin of an http(s) write (any method but GET/HEAD/OPTIONS) outside `allowed`, else undefined. */
export function offAllowlistWriteOrigin(method: string, url: string, allowed: ReadonlySet<string>): string | undefined {
  if (READ_METHODS.has(method.toUpperCase())) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return allowed.has(canonicalOrigin(url) ?? u.origin) ? undefined : u.origin;
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

/** One origin's entry of the targets file, by `canonicalOrigin` (the keys may be written with a trailing slash). */
function targetForOrigin(targets: Readonly<Record<string, TargetConfig>>, origin: string): TargetConfig | undefined {
  // A key that is no URL is no origin's entry.
  return Object.entries(targets).find(([key]) => canonicalOrigin(key) === origin)?.[1];
}

/** Every origin of a declared environment flagged `production: true` (a `baseUrl` naming one counts as `env` naming it). */
function declaredProductionOrigins(environmentsFile: string | null): ReadonlySet<string> {
  if (environmentsFile === null) return new Set();
  return allowedOriginSet(Object.values(loadEnvironmentsFile(environmentsFile)).flatMap((e) => (e.production === true ? [e.baseUrl, ...Object.values(e.origins ?? {})] : [])));
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
  /** For a replay with no write guard to arm (`verify_fix`): a production origin in the allowlist refuses the run, not just a write there. */
  readonly refuseProductionInAllowlist?: boolean;
  /**
   * 0.30.0 §5.4: the run's mode (journey-run-mode-gate.ts). With `authoredOrigins`, a Journey's own
   * `allowedOrigins` leave the write allowlist in automation mode (a write there needs
   * `mcpRun.allowOffAllowlistWrites`). In test mode the guard's allowlist is automation mode's, and what
   * test mode adds is bounded by the declared environment (§5.1, `TestModeRelaxation`): an authored
   * origin the environment does not declare is refused there too. Absent: as 0.29.0.
   */
  readonly mode?: RunMode | undefined;
  /** The Journey's authored `metadata.allowedOrigins` (they are in `allowedOrigins` too). */
  readonly authoredOrigins?: readonly string[] | undefined;
  /**
   * 0.30.0 §5.1: told of each action test mode allowed that automation mode refuses (a destructive
   * control, a write to a declared origin off the allowlist). Code-templated, never a value: for the
   * run's evidence.
   */
  readonly onRelaxed?: ((note: string) => void) | undefined;
}

/**
 * 0.30.0 §5.1, test mode: what loosens, and where. A destructive control (the built-in
 * `builtin:destructive` rule only: session-ending and paid controls, and a target's own `safety.deny`,
 * still refuse) and a write to an origin the test-trusted target declares (a test environment's
 * `baseUrl` and named `origins`, or the origin a `targets.json` `trust: "test"` names). A write to any
 * other origin is still refused, a Journey's own `allowedOrigins` included (an agent can author those),
 * and a production origin refuses in every mode.
 */
export interface TestModeRelaxation {
  readonly declaredOrigins: ReadonlySet<string>;
  readonly onRelaxed: (note: string) => void;
}

/**
 * The write allowlist of an MCP run: in automation mode, `allowedOrigins` less the origins only the
 * Journey's author added (the site and the environment's own origins stay). PURE.
 */
export function modeWriteAllowlist(req: Pick<McpRunGuardRequest, "site" | "allowedOrigins" | "environment" | "mode" | "authoredOrigins">): readonly string[] {
  if (req.mode !== "automation" || (req.authoredOrigins ?? []).length === 0) return req.allowedOrigins;
  const kept = allowedOriginSet([req.site, ...(req.environment?.allowedOrigins ?? [])]);
  const authored = allowedOriginSet(req.authoredOrigins ?? []);
  return req.allowedOrigins.filter((o) => {
    const c = canonicalOrigin(o);
    return c === undefined || kept.has(c) || !authored.has(c);
  });
}

const productionRefusal = (origin: string, what: string): RunGuardRefusedError => {
  const setting = `targets.json["${origin}"].mcpRun.allowProduction`;
  return new RunGuardRefusedError("E_RUN_REFUSED_PRODUCTION", `${what} A person allows it with ${setting}: true. ${DO_NOT_RETRY}`, setting);
};

/**
 * The guard of one MCP-driven replay, decided before any fixture or browser: undefined outside an MCP
 * invocation. Refuses here a production environment and a config it cannot read (fail closed).
 */
export function prepareMcpRunGuard(req: McpRunGuardRequest): McpRunGuard | undefined {
  if (!inMcpInvocation()) return undefined;
  const origin = canonicalOrigin(req.site) ?? req.site;
  let target: TargetConfig | undefined;
  let production: boolean;
  let heldBack: ReadonlySet<string>;
  try {
    const targets = req.targetsFile === undefined ? loadTargetsFile() : loadTargetsFile(req.targetsFile);
    target = targetForOrigin(targets, origin);
    const flagged = new Set([...declaredProductionOrigins(req.environmentsFile ?? environmentsFilePath()), ...allowedOriginSet(Object.entries(targets).flatMap(([key, t]) => (t.trust === "production" ? [key] : [])))]);
    // 0.30.0 §5: the operator's `trust: "production"` for the origin counts as `production: true`.
    production = req.environment?.production === true || flagged.has(origin) || target?.trust === "production";
    heldBack = new Set([...flagged].filter((o) => targetForOrigin(targets, o)?.mcpRun?.allowProduction !== true));
  } catch (err) {
    throw refused(new RunGuardRefusedError("E_RUN_GUARD_CONFIG", `an MCP run could not read what allows it on ${origin}, so it does not run: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, "targets.json / environments.json"));
  }
  const allowances = target?.mcpRun ?? {};
  if (production && allowances.allowProduction !== true) {
    throw refused(productionRefusal(origin, `${origin} is flagged production: true, and an MCP run does not replay there by default.`));
  }
  if (req.refuseProductionInAllowlist === true) {
    for (const allowed of allowedOriginSet(req.allowedOrigins)) {
      if (heldBack.has(allowed)) throw refused(productionRefusal(allowed, `${allowed} is in this replay's allowlist and flagged production: true, and an MCP run does not replay with it by default.`));
    }
  }
  return new McpRunGuard(origin, guardWriteAllowlist(req), allowances, target, heldBack, currentMcpInvocation(), testModeRelaxation(req));
}

/**
 * The guard's own write allowlist. In test mode it is automation mode's (a Journey's authored origins
 * left out): what test mode adds is bounded by the declared environment (`testModeRelaxation`).
 */
function guardWriteAllowlist(req: McpRunGuardRequest): readonly string[] {
  return req.mode === "test" ? modeWriteAllowlist({ ...req, mode: "automation" }) : modeWriteAllowlist(req);
}

/**
 * Test mode's relaxation, decided again from the same human-written files the run-mode gate read: a
 * run the files do not put in test mode gets none, whatever `mode` says.
 */
function testModeRelaxation(req: McpRunGuardRequest): TestModeRelaxation | undefined {
  if (req.mode !== "test") return undefined;
  const at = { origin: req.environment?.baseUrl ?? req.site, environment: req.environment, targetsFile: req.targetsFile, ...(req.environmentsFile === undefined ? {} : { environmentsFile: req.environmentsFile }) };
  if (resolveRunTarget(at).mode !== "test") return undefined;
  return { declaredOrigins: allowedOriginSet(testDeclaredOrigins(at)), onRelaxed: req.onRelaxed ?? (() => undefined) };
}

function refused(err: RunGuardRefusedError): RunGuardRefusedError {
  noteMcpRefusal(err);
  return err;
}

/** The nearest element a click on `locator` activates, when it is not the element itself. */
const INTERACTIVE_ANCESTOR = 'xpath=ancestor-or-self::*[self::button or self::a or self::summary or self::input or @role="button" or @role="link" or @role="menuitem" or @role="tab"][1]';
/**
 * What one `keyboard.press` holds down, split as Playwright splits it: a `+` ends a key unless it would
 * be the first character of one. Every key is pressed in turn, so one that activates need not be last
 * (`Enter+a`). A recorded key is free-form text, so this reads what the browser will be told.
 */
export function pressedKeys(key: string): string[] {
  const keys: string[] = [];
  let building = "";
  for (const char of key) {
    if (char === "+" && building !== "") {
      keys.push(building);
      building = "";
    } else {
      building += char;
    }
  }
  return [...keys, building];
}

/** Enter as Playwright takes it, by name, on the keypad, or as the characters it aliases to it. Case is ignored: a wrong-cased name it refuses presses nothing. */
const ENTER_KEYS: ReadonlySet<string> = new Set(["enter", "numpadenter", "\n", "\r"]);
const SPACE_KEYS: ReadonlySet<string> = new Set(["space", " "]);
const pressesAny = (key: string, of: ReadonlySet<string>): boolean => pressedKeys(key).some((k) => of.has(k.toLowerCase()));
/** A key press in a text field types or submits; the field's name says nothing about what it does. */
const TEXT_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "combobox"]);
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

/** Frames within frames, as deep as anyone would nest a control a key reaches. */
const MAX_FRAME_DEPTH = 8;

/**
 * The element holding focus, inside any frame: undefined if none does. A key goes there, and `:focus`
 * in the page matches nothing while focus is in a frame. Past the depth, nothing is found, as an unnamed frame would be.
 */
async function focusedThroughFrames(focused: Locator): Promise<Locator | undefined> {
  let frame = focused.page().mainFrame();
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
    // BROWSER CODE
    const active = await frame.evaluateHandle(() => document.activeElement);
    const inner = (await active.asElement()?.contentFrame()) ?? null;
    await active.dispose();
    if (inner === null) break;
    frame = inner;
  }
  const inFrame = frame.locator(":focus");
  return (await inFrame.count()) === 0 ? undefined : inFrame;
}

export class McpRunGuard implements ReplayActionGuard {
  readonly #origin: string;
  readonly #allowed: ReadonlySet<string>;
  readonly #policy: SafetyPolicy;
  #values: string[] = [];
  #refusal: RunGuardRefusedError | undefined;
  #step: number | undefined;
  #onRefusedWrite: ((request: Request) => void) | undefined;
  #dispose: (() => Promise<void>) | undefined;
  #disposed = false;
  /** Origins flagged `production: true` with no `allowProduction` of their own: no write reaches one, whatever the allowlist says. */
  readonly #heldBack: ReadonlySet<string>;
  /** The tool call this run is part of, from when it was prepared: a route's callback runs in the async context of whichever call launched a pooled browser. */
  readonly #invocation: McpInvocation | undefined;
  /** 0.30.0 §5.1: test mode's relaxation, if this run is in test mode. */
  readonly #relax: TestModeRelaxation | undefined;
  /** What was relaxed already: one note per action. */
  readonly #relaxedNoted = new Set<string>();

  constructor(
    origin: string,
    allowedOrigins: readonly string[],
    allowances: McpRunAllowances,
    target: TargetConfig | undefined,
    heldBack: ReadonlySet<string> = new Set(),
    invocation?: McpInvocation,
    relax?: TestModeRelaxation,
  ) {
    this.#origin = origin;
    this.#heldBack = heldBack;
    this.#invocation = invocation;
    this.#relax = relax;
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
      if (!this.#judgeWrite(request.method(), request.url(), "")) {
        await route.fallback().catch(() => undefined);
        return;
      }
      this.#onRefusedWrite?.(request);
      await route.abort("blockedbyclient").catch(() => undefined);
    };
    // A route sees only a redirect chain's first request; what it could not stop still ends the run.
    const onRequest = (request: Request): void => {
      if (request.redirectedFrom() === null) return;
      this.#judgeWrite(request.method(), request.url(), " It came as a redirect from an allowed origin, which a browser cannot be stopped from following, so it may have been sent.");
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
    const url = ws.url().replace(/^ws/, "http");
    // A socket route outlives `dispose` (it has no unroute): a session a mission goes on using gets its sockets back.
    if (this.#disposed || !this.#writeIsRefused("WEBSOCKET", url)) return false;
    ws.onMessage(() => void this.#judgeWrite("WEBSOCKET", url, ""));
    return true;
  }

  /** A value the run extracted: a refusal that quotes it gives it to the model. */
  noteExtracted(value: string): void {
    this.#values.push(value);
  }

  #mask(piece: string): string {
    return maskValues(piece, this.#values, "[param]");
  }

  #productionWriteOrigin(method: string, url: string): string | undefined {
    const origin = offAllowlistWriteOrigin(method, url, new Set());
    const canonical = origin === undefined ? undefined : canonicalOrigin(url);
    return canonical !== undefined && this.#heldBack.has(canonical) ? canonical : undefined;
  }

  /** The origin of a write off the allowlist that test mode allows (the declared environment's), else undefined. */
  #relaxedWriteOrigin(method: string, url: string): string | undefined {
    if (this.#relax === undefined) return undefined;
    const off = offAllowlistWriteOrigin(method, url, this.#allowed);
    if (off === undefined) return undefined;
    const canonical = canonicalOrigin(url);
    return canonical !== undefined && this.#relax.declaredOrigins.has(canonical) ? canonical : undefined;
  }

  #writeIsRefused(method: string, url: string): boolean {
    if (this.#productionWriteOrigin(method, url) !== undefined) return true;
    return offAllowlistWriteOrigin(method, url, this.#allowed) !== undefined && this.#relaxedWriteOrigin(method, url) === undefined;
  }

  /** Tells the run's evidence, once per action, what test mode allowed. Code-templated: a rule or an origin, a step, never a value. */
  #noteRelaxed(key: string, note: string): void {
    if (this.#relax === undefined || this.#relaxedNoted.has(key)) return;
    this.#relaxedNoted.add(key);
    this.#relax.onRelaxed(note);
  }

  /** Ends the run if this write is one it refuses, and says whether it was. A production origin first: the allowlist has no say there. */
  #judgeWrite(method: string, url: string, note: string): boolean {
    const production = this.#productionWriteOrigin(method, url);
    if (production !== undefined) {
      this.#refuseProductionWrite(production, note);
      return true;
    }
    const off = offAllowlistWriteOrigin(method, url, this.#allowed);
    if (off === undefined) return false;
    const relaxed = this.#relaxedWriteOrigin(method, url);
    if (relaxed !== undefined) {
      const shown = this.#mask(relaxed);
      this.#noteRelaxed(`write ${this.#step ?? -1} ${relaxed}`, `test mode allowed a write${this.#stepPhrase()} to ${shown}, off the automation-mode allowlist and declared by the test environment`);
      return false;
    }
    this.#refuseWrite(off, note);
    return true;
  }

  #stepPhrase(): string {
    return this.#step === undefined ? "" : ` at step ${this.#step + 1}`;
  }

  #refuseProductionWrite(origin: string, note: string): void {
    if (this.#refusal !== undefined) return;
    const shown = this.#mask(origin);
    const base = productionRefusal(shown, `the page sent a write to ${shown}${this.#stepPhrase()}, which is flagged production: true, and an MCP run refuses it whatever its allowlist says.${note}`);
    this.#refusal = this.#owned(new RunGuardRefusedError(base.code, base.message, base.setting, this.#step === undefined ? {} : { at: this.#step + 1 }));
  }

  /** Recorded on this run's own tool call, never the one whose async context a browser callback happens to run in. */
  #owned(err: RunGuardRefusedError): RunGuardRefusedError {
    noteMcpRefusal(err, this.#invocation);
    return err;
  }

  #refuseWrite(off: string, note: string): void {
    if (this.#refusal !== undefined) return;
    const shown = this.#mask(off);
    const setting = `targets.json["${this.#origin}"].mcpRun.allowOffAllowlistWrites`;
    const at = this.#stepPhrase();
    this.#refusal = this.#owned(
      new RunGuardRefusedError(
        "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE",
        `the page sent a write to ${shown}${at}, outside this run's allowed origins, and an MCP run refuses it by default.${note} A person allows that origin with ${setting}: ["${shown}"]. ${DO_NOT_RETRY}`,
        setting,
        this.#step === undefined ? {} : { at: this.#step + 1 },
      ),
    );
  }

  /**
   * Test mode lets a destructive control act (the built-in destructive rule only) and records it; true
   * when it did. A session-ending or paid control, and the target's own `safety.deny`, still refuse.
   */
  #relaxControl(verdict: SafetyVerdict, index: number): boolean {
    if (this.#relax === undefined || verdict.risk !== "destructive" || verdict.refusal.ruleId !== "builtin:destructive") return false;
    this.#noteRelaxed(`control ${index}`, `test mode allowed step ${index + 1}'s destructive control (rule builtin:destructive), which automation mode refuses`);
    return true;
  }

  #refuseControl(verdict: SafetyVerdict, index: number): void {
    if (this.#relaxControl(verdict, index)) return;
    const { ruleId, pattern } = verdict.refusal;
    // A target's own `safety.deny` is what refuses it: nothing here lifts it. Its words are the operator's; the control's never appear.
    const denied = ruleId.startsWith("deny:") || ruleId === "builtin:nameless-control";
    const setting = denied ? `targets.json["${this.#origin}"].safety.deny` : `targets.json["${this.#origin}"].mcpRun.allowDestructive`;
    const what = verdict.risk === "session-end" ? "ends the session" : verdict.risk === "destructive" ? "is destructive" : verdict.risk === "paid" ? "may cost money or reach real people" : "is denied by the target";
    const lift = denied ? `The target's ${setting} refuses it; a person changes that.` : `A person allows it for this target with ${setting}: true.`;
    this.#refusal = this.#owned(
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
    if (ctx.key !== undefined && !pressesAny(ctx.key, ENTER_KEYS) && !pressesAny(ctx.key, SPACE_KEYS)) return;
    if (typeof ctx.locator.evaluate !== "function") return; // A test double's locator has no element to read.
    const locator = ctx.key === undefined ? ctx.locator : await focusedThroughFrames(ctx.locator);
    if (locator === undefined) return; // No element holds focus: the key activates nothing.
    if (ctx.key !== undefined && pressesAny(ctx.key, ENTER_KEYS)) {
      // What Enter submits is named on the form's default button, whatever the field is called.
      const handle = await locator.evaluateHandle(defaultButtonOf);
      const button = handle.asElement();
      const named = button === null ? null : await readControlIdentity(button);
      await handle.dispose();
      const verdict = named === null ? null : this.#judge(named.name, named.role, ctx.recorded);
      if (verdict !== null) this.#refuseControl(verdict, ctx.index);
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

// --- The ratchet (0.30.0 §5.4, #799): over MCP a site policy may only tighten -----------------------

export const E_POLICY_LOOSEN_OVER_MCP = "E_POLICY_LOOSEN_OVER_MCP" as const;
export const E_TARGET_PROMOTE_OVER_MCP = "E_TARGET_PROMOTE_OVER_MCP" as const;

const minutesOf = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** The minutes of the day a set of quiet-hours windows covers ([start, end), wrapping past midnight). */
function quietMinutes(windows: readonly { readonly start: string; readonly end: string }[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const w of windows) {
    const start = minutesOf(w.start);
    const end = minutesOf(w.end);
    for (let m = 0; m < 24 * 60; m++) if (start <= end ? m >= start && m < end : m >= start || m < end) out.add(m);
  }
  return out;
}

/** A pause distribution is looser when it waits less: a lower mean, a lower floor, or a lower ceiling. */
function distLoosenings(path: string, was: DistParams | undefined, now: DistParams | undefined): string[] {
  if (was === undefined) return [];
  if (now === undefined) return [path];
  const out: string[] = [];
  if (now.mean < was.mean) out.push(`${path}.mean`);
  if (was.min !== undefined && (now.min === undefined || now.min < was.min)) out.push(`${path}.min`);
  // Compare EFFECTIVE ceilings: no max is an infinite one, so adding a max (or lowering it) cuts the pause.
  if ((now.max ?? Infinity) < (was.max ?? Infinity)) out.push(`${path}.max`);
  return out;
}

/** `was` is a floor: absent or lower is looser. */
const floor = (path: string, was: number | undefined, now: number | undefined): string[] => (was !== undefined && (now === undefined || now < was) ? [path] : []);
/** `was` is a limit: absent or higher is looser. */
const limit = (path: string, was: number | undefined, now: number | undefined): string[] => (was !== undefined && (now === undefined || now > was) ? [path] : []);

/**
 * Every axis on which `proposed` is looser than the `effective` policy of the same site and account,
 * as a path (`throttles.write.minIntervalSeconds`, `quietHours`, `interaction.typing.charsPerSecond`).
 * Empty: at least as strict everywhere (pacing, interval, budget, quiet hours). No effective policy: any
 * policy tightens. PURE. A field the effective policy does not set is not an axis it holds.
 */
export function policyLoosenings(effective: SitePolicy | null, proposed: SitePolicy): string[] {
  if (effective === null) return [];
  const out: string[] = [];
  for (const [cls, was] of Object.entries(effective.throttles ?? {})) {
    const now = proposed.throttles?.[cls];
    out.push(
      ...floor(`throttles.${cls}.minIntervalSeconds`, was.minIntervalSeconds, now?.minIntervalSeconds),
      ...limit(`throttles.${cls}.hourlyLimit`, was.hourlyLimit, now?.hourlyLimit),
      ...limit(`throttles.${cls}.dailyLimit`, was.dailyLimit, now?.dailyLimit),
    );
  }
  const quiet = effective.quietHours;
  if (quiet !== undefined && quiet.windows.length > 0) {
    const now = proposed.quietHours;
    if (now === undefined || now.timezone !== quiet.timezone) out.push("quietHours");
    else {
      const covered = quietMinutes(now.windows);
      if ([...quietMinutes(quiet.windows)].some((m) => !covered.has(m))) out.push("quietHours.windows");
    }
  }
  const pace = effective.interaction;
  if (pace !== undefined) {
    const now = proposed.interaction;
    if (now === undefined) out.push("interaction");
    else {
      out.push(...distLoosenings("interaction.thinkBeforeActionMs", pace.thinkBeforeActionMs, now.thinkBeforeActionMs));
      out.push(...distLoosenings("interaction.interInteractionMs", pace.interInteractionMs, now.interInteractionMs));
      out.push(...floor("interaction.readingMsPerChar", pace.readingMsPerChar, now.readingMsPerChar));
      // A reading cap: a lower one reads faster. No cap at all is the slowest.
      // Effective cap: absent is infinite, so adding a cap loosens whenever the effective policy reads at all.
      if ((pace.readingMsPerChar ?? 0) > 0 && (now.maxReadingMs ?? Infinity) < (pace.maxReadingMs ?? Infinity)) out.push("interaction.maxReadingMs");
      const typing = pace.typing;
      if (typing !== undefined) {
        const t = now.typing;
        if (t === undefined) out.push("interaction.typing");
        else {
          if (t.charsPerSecond > typing.charsPerSecond) out.push("interaction.typing.charsPerSecond");
          out.push(...distLoosenings("interaction.typing.wordPauseMs", typing.wordPauseMs, t.wordPauseMs));
          out.push(...distLoosenings("interaction.typing.sentencePauseMs", typing.sentencePauseMs, t.sentencePauseMs));
          if (typing.hesitation !== undefined) {
            if (t.hesitation === undefined) out.push("interaction.typing.hesitation");
            else {
              if (t.hesitation.probability < typing.hesitation.probability) out.push("interaction.typing.hesitation.probability");
              out.push(...distLoosenings("interaction.typing.hesitation.pauseMs", typing.hesitation.pauseMs, t.hesitation.pauseMs));
            }
          }
        }
      }
    }
  }
  return out;
}

/** The MCP refusal body for a site policy looser than the effective one: the axes, never a value. */
export function policyLoosenRefusalBody(site: string, axes: readonly string[]): Record<string, unknown> {
  return {
    error: "refused",
    outcome: "refused",
    code: E_POLICY_LOOSEN_OVER_MCP,
    axes,
    message: `${E_POLICY_LOOSEN_OVER_MCP}: over MCP a site policy may only be at least as strict as the effective one on every axis; this one for ${site} is looser on ${axes.join(", ")}, so nothing was set. A person loosens a policy at a terminal: jevitate site policy set ${site} --file <policy.json>. ${DO_NOT_RETRY}`,
    setting: `jevitate site policy set ${site}`,
    retryable: false,
    exitCode: EXIT_CODES.inconclusive,
  };
}

/** The MCP refusal body for promoting a mission target: a CLI act (docs/safety.md). */
export function targetPromoteRefusalBody(id: string): Record<string, unknown> {
  return {
    error: "refused",
    outcome: "refused",
    code: E_TARGET_PROMOTE_OVER_MCP,
    message: `${E_TARGET_PROMOTE_OVER_MCP}: promoting a mission target is a person's act, and an MCP call cannot do it; nothing was promoted. A person runs: jevitate mission target promote ${id}. ${DO_NOT_RETRY}`,
    setting: `jevitate mission target promote ${id}`,
    retryable: false,
    exitCode: EXIT_CODES.inconclusive,
  };
}
