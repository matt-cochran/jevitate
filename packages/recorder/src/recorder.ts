import type { ElementHandle, Frame, Page } from "playwright";
import type { BrowserSession } from "@jevitate/playwright";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { assembleRecording, assembleWithValues, pathOrRaw } from "./assemble.js";
import {
  buildCandidates,
  validateCandidates,
  CAPPED_STABILITY,
  EID_ATTRIBUTE,
  type DescriptorCandidate,
  type ElementFacts,
  type Stability,
} from "./descriptor.js";
import { installRecorderListener } from "./inject.js";

/** The name the injected script calls: `window.__doitRecord(payload)`. */
export const RECORD_BINDING = "__doitRecord";

/** The raw DOM event kinds the injected listener reports. */
export type DomEventKind = "click" | "input" | "change" | "keydown" | "submit";

const DOM_EVENT_KINDS: readonly string[] = ["click", "input", "change", "keydown", "submit"];

/**
 * The payload the in-page listener sends. `rawText` is *absent* (not
 * `undefined`) whenever the acted element is a password / one-time-code field:
 * its value is never read in the page, so it never crosses into Node.
 */
export interface CapturedActionPayload {
  /** Value of the temporary `data-doit-eid` attribute, unique per document. */
  readonly eid: string;
  readonly kind: DomEventKind;
  /** Lowercase tag name of the acted element, e.g. `"button"`. */
  readonly tag: string;
  /** Normalized `type` for `<input>` elements only. */
  readonly typeAttr?: string;
  /** Trimmed text for click/submit; current value for input/change. */
  readonly rawText?: string;
  /**
   * The acted element's DOM facts, read **in the page, synchronously, in the
   * same tick as the action** (see `inject.ts`). Present for the kinds that
   * become a Step (`click`/`input`/`change`); absent for `keydown`/`submit`,
   * which never need a descriptor.
   *
   * These are what the descriptor ladder is built from, and gathering them at
   * capture time rather than asking the page afterwards is what lets an action
   * that destroys its own document still be described.
   */
  readonly facts?: ElementFacts;
  /**
   * `location.href` of the document the action happened in. Node compares it
   * against the frame's current URL to decide whether live validation of the
   * facts is still meaningful.
   */
  readonly docUrl?: string;
  /** Page-side `Date.now()` — authoritative for ordering and timing. */
  readonly ts: number;
}

/**
 * The outcome of resolving a captured `eid` back to a live element and
 * computing its descriptor. Computed **while the recording is running**, not at
 * `stop()` time — see `Recorder.resolve`.
 */
/**
 * Why an action could not be described. Assembly turns each of these into its
 * own `handback` wording, so the human who has to take over is told what
 * actually went wrong rather than "something did".
 */
export type ResolutionFailureCause =
  /** The action happened in a nested frame, which descriptor computation does not cover. */
  | "sub-frame"
  /**
   * The page navigated while the description was being computed.
   *
   * No longer produced: the facts a descriptor is built from are now read
   * in-page at the moment of the action, so a navigation costs the *validation*
   * of those facts, not the description itself (see `compute`). Kept because it
   * remains part of `assemble.ts`'s handback vocabulary and describes a real
   * predicament a future capture path could still land in.
   */
  | "document-replaced"
  /**
   * No descriptor was ever attempted for this action — nothing was recording
   * when it arrived. `assemble.ts` uses this cause for that case.
   */
  | "element-gone"
  /** The element is there, but no descriptor provably resolves back to it. */
  | "not-identifiable";

export type DescriptorResolution =
  | {
      readonly ok: true;
      readonly descriptor: TargetDescriptor;
      readonly stability: Stability;
      readonly alternates: readonly TargetDescriptor[];
    }
  | {
      readonly ok: false;
      readonly cause: ResolutionFailureCause;
      /** The underlying detail; diagnostic, and surfaced in review. */
      readonly reason: string;
      /**
       * The path the action happened on, captured at failure time. With no
       * descriptor there is no `visible` target to resume on, so this is the
       * fallback an assembled `handback` uses — always constructible.
       */
      readonly resumePath: string;
    };

export interface ActionCaptureEvent {
  readonly type: "action";
  /** Monotonic arrival order within this Recorder. */
  readonly seq: number;
  /** Node-side receive time; diagnostic only (includes IPC latency). */
  readonly receivedAt: number;
  /** URL of the frame the action happened in. */
  readonly frameUrl: string;
  readonly payload: CapturedActionPayload;
  /**
   * Deliberately mutable, and deliberately optional. The event is buffered
   * synchronously so the buffer preserves true arrival order; the descriptor is
   * settled a moment later, once its best-effort validation against the live
   * page has run (or been abandoned). `undefined` means it was never attempted —
   * either the kind needs none (`keydown`/`submit`) or no recording was running.
   */
  resolution?: DescriptorResolution;
}

export interface NavigationCaptureEvent {
  readonly type: "navigation";
  readonly seq: number;
  readonly receivedAt: number;
  readonly url: string;
  readonly isMainFrame: boolean;
}

export type CaptureEvent = ActionCaptureEvent | NavigationCaptureEvent;

/**
 * `Recorder.stopAuthoring()`'s result: the same redacted `Recording`
 * `stop()` would produce for the same buffer, plus a **local-only** map of
 * the actual (pre-redaction) value captured for every non-secret fill/select
 * step, for future authoring tooling (diff / variable-binding — RxD Phase
 * A.3a) that needs the real values a persisted `Recording` deliberately never
 * carries.
 *
 * `values` is keyed `` `${pageIndex}:${stepIndexInPage}` `` — see
 * `assembleWithValues` in `assemble.ts` for the exact contract, including
 * what does and does not get an entry.
 *
 * **This object is local-authoring-only.** `.values` must never be
 * persisted (it never touches `RecordingStore`), never serialized into a
 * `Recording`, and never sent to a model — treat it exactly the way
 * `.recording` already treats a secret field's value: as something that does
 * not leave this process.
 */
export interface AuthoringRecording {
  readonly recording: Recording;
  readonly values: Map<string, string>;
}

/**
 * Records a demonstrated journey as a schema-valid `Recording`.
 *
 * Transport: `page.addInitScript` injects the listener into every document of
 * every frame; `page.exposeBinding` receives each action; `framenavigated`
 * records navigations Node-side (they are not observed in the page), and those
 * interleaved navigations are what `assemble.ts` splits into `PageSegment`s.
 *
 * Three phases, and the split between them is the design:
 *
 *  1. `install()` arms capture. Raw events are buffered and the DOM is left
 *     exactly as it was found.
 *  2. `start()`…`stop()` is a recording. Each action arrives carrying the facts
 *     the page read about the acted element *synchronously, in the event
 *     handler* (see `inject.ts`), and its descriptor is settled **as it
 *     arrives**, not at the end — by `stop()` the journey has crossed several
 *     documents and `[data-doit-eid=N]` cannot be queried on a page that was
 *     navigated away from three steps ago. Resolving per action also disposes
 *     of the "an `eid` is only unique per document" hazard.
 *  3. `stop()` translates the buffer (see `assemble.ts`). Pure: no DOM is
 *     touched, because every DOM question was already answered in phase 2.
 */
export class Recorder {
  private readonly buffer: CaptureEvent[] = [];
  private seq = 0;
  private installed = false;
  private recording = false;
  private startedAtIso: string | undefined;
  private intent: string | undefined;
  /**
   * In-flight or finished descriptor computations, keyed `"<epoch>:<eid>"`.
   *
   * The **promise** is memoized, not the result, and that is load-bearing: one
   * field emits several events (a keystroke each, then a blur-time `change`),
   * they arrive while the first computation is still running, and the first
   * computation *removes* the `data-doit-eid` attribute when it finishes. A
   * result-only memo would have every later event miss, re-query a tag that no
   * longer exists, and degrade a perfectly good `fill` into a `handback`.
   *
   * The epoch prefix scopes the memo to one document: `eid`s restart at 1 in
   * every new document, so an answer about the previous page must never be
   * readable as an answer about this one.
   */
  private readonly resolutions = new Map<string, Promise<DescriptorResolution>>();
  private epoch = 0;
  /** Resolutions still in flight, so `stop()` can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly session: BrowserSession,
    /** Site identifier written to `Recording.site`. */
    private readonly site: string,
  ) {}

  /**
   * Arms in-page capture. Idempotent: `exposeBinding` would throw if
   * registered twice.
   *
   * Installing only *buffers raw events*; it computes no descriptors. Those
   * begin at `start()`, because computing a descriptor mutates the page (it
   * strips the temporary `data-doit-eid` tag), and an armed-but-not-recording
   * session should leave the DOM exactly as it found it.
   */
  async install(): Promise<void> {
    const page = this.session.page;
    if (this.installed) return;
    this.installed = true;

    await page.exposeBinding(
      RECORD_BINDING,
      async (source: { page: Page; frame: Frame }, payload: unknown) => {
        await this.onAction(source, payload);
      },
    );
    await page.addInitScript(installRecorderListener);

    page.on("framenavigated", (frame: Frame) => {
      const isMainFrame = frame === page.mainFrame();
      // A new main-frame document restarts the page's `eid` counter, so every
      // memoized resolution is now about elements that no longer exist.
      if (isMainFrame) {
        this.epoch += 1;
        this.resolutions.clear();
      }
      this.buffer.push({
        type: "navigation",
        seq: this.seq++,
        receivedAt: Date.now(),
        url: frame.url(),
        isMainFrame,
      });
    });
  }

  /**
   * Begins a recording: arms capture if needed, drops anything captured before
   * now, and starts computing a descriptor for every action as it arrives.
   *
   * `intent` is the user's own framing of the journey ("sign in and open the
   * inbox"), carried through to `Recording.intent` for the postdoc review and
   * the LLM naming pass.
   */
  async start(intent?: string): Promise<void> {
    await this.install();
    this.clear();
    this.resolutions.clear();
    this.startedAtIso = new Date().toISOString();
    this.intent = intent;
    this.recording = true;
  }

  /**
   * Ends the recording and assembles the buffer into a schema-valid
   * `Recording`. Throws if the result does not parse — an unparseable
   * recording cannot be replayed, reviewed or stored, so returning one would
   * only move the failure somewhere less diagnosable.
   *
   * The transport stays installed: Playwright offers no way to remove an
   * exposed binding, and re-arming for a second take is `start()`'s job.
   */
  async stop(retro?: string): Promise<Recording> {
    await this.finalize();
    return assembleRecording(this.buffer, {
      site: this.site,
      startedAtIso: this.startedAtIso,
      intent: this.intent,
      retro,
    });
  }

  /**
   * Like `stop()`, but additionally returns the actual (pre-redaction) value
   * captured for every non-secret fill/select step — see `AuthoringRecording`.
   *
   * `.recording` here is produced by the exact same assembly pass `stop()`
   * uses: `assembleWithValues` *is* `assembleRecording`'s implementation, with
   * the value side-channel tapped off internally, so this method cannot make
   * `.recording` diverge from what `stop()` would have returned for the same
   * buffer, and there is no separate re-derivation of page/step segmentation
   * to drift out of sync with it.
   *
   * Local-authoring-only: see `AuthoringRecording`'s doc comment for what must
   * never happen to `.values` (never persisted, never sent to a model, never
   * touches `RecordingStore`).
   */
  async stopAuthoring(retro?: string): Promise<AuthoringRecording> {
    await this.finalize();
    return assembleWithValues(this.buffer, {
      site: this.site,
      startedAtIso: this.startedAtIso,
      intent: this.intent,
      retro,
    });
  }

  /**
   * The shared tail of `stop()`/`stopAuthoring()`: stops accepting new
   * actions as steps, waits out any descriptor computation still in flight,
   * and removes the capture tags. Assembly itself is each caller's own job,
   * because `stop()` and `stopAuthoring()` differ only in which assembly
   * function they hand the (now-final) buffer to.
   */
  private async finalize(): Promise<void> {
    this.recording = false;
    // An action captured a moment before `stop()`/`stopAuthoring()` may still
    // be resolving its descriptor; assembling without it would silently
    // demote a real step to a handback.
    await Promise.allSettled([...this.inFlight]);
    // The capture tags exist only for the duration of a recording: the in-page
    // listener reuses an element's `eid` for as long as the attribute is there,
    // which is what keeps a field's many events reading as one element. Now
    // that no further event can arrive, the page the user is still looking at
    // gets its DOM back.
    await this.untagAll();
  }

  /** Everything captured so far, in arrival order. */
  get events(): readonly CaptureEvent[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  private async onAction(source: { page: Page; frame: Frame }, raw: unknown): Promise<void> {
    const payload = toPayload(raw);
    if (payload === undefined) return;
    // Everything up to here is synchronous, so the buffer's order is the true
    // arrival order regardless of how long resolution takes.
    const event: ActionCaptureEvent = {
      type: "action",
      seq: this.seq++,
      receivedAt: Date.now(),
      frameUrl: source.frame.url(),
      payload,
    };
    this.buffer.push(event);

    if (!this.recording || !NEEDS_DESCRIPTOR.has(payload.kind)) return;
    // Deliberately NOT awaited here, and that is measured rather than assumed.
    // Describing an element costs many DOM round trips, and the binding call
    // for the next action is already on its way; awaiting would serialize the
    // descriptions and make each one start later than the event it describes,
    // which is exactly when they lose their race against the page. They must
    // all start the instant their event arrives. `stop()` waits for whatever
    // is still outstanding.
    const pending = this.resolve(source, event);
    this.inFlight.add(pending);
    void pending.finally(() => this.inFlight.delete(pending));
  }

  /**
   * Turns an action's captured facts into a descriptor — **now, while the
   * recording is running**, not at `stop()`.
   *
   * This is the whole reason capture and assembly are split the way they are.
   * By the time `stop()` runs, the user has demonstrated a journey across
   * several documents, and no question can be asked of a page that was
   * navigated away from three steps ago. Validating per action also disposes of
   * the "an `eid` is only unique per document" hazard: the tag is queried while
   * the document that minted it is still the one on screen.
   *
   * Never throws. A failure is recorded as data (`{ok: false}`) and becomes a
   * `handback` at assembly time, because "this action is not reliably
   * replayable" is a fact about the recording, not an error in taking it.
   */
  private async resolve(source: { page: Page; frame: Frame }, event: ActionCaptureEvent): Promise<void> {
    const page = this.session.page;
    const { eid } = event.payload;
    const epoch = this.epoch;
    const key = `${epoch}:${eid}`;

    if (source.frame !== source.page.mainFrame()) {
      // Descriptor computation is main-frame only — `compute` validates against
      // the page, not the frame, and `docUrl`/epoch only track the main frame —
      // so a sub-frame action is routed to a human rather than described
      // wrongly.
      event.resolution = {
        ok: false,
        cause: "sub-frame",
        reason: "action happened in a sub-frame; descriptor computation is main-frame only",
        resumePath: pathOrRaw(source.page.url()),
      };
      return;
    }

    // Registered *before* the first await, so every event for this element
    // that arrives while the computation is running shares its answer instead
    // of starting a second, identical set of validation probes.
    let pending = this.resolutions.get(key);
    if (pending === undefined) {
      pending = this.compute(page, event.payload, epoch);
      this.resolutions.set(key, pending);
    }
    event.resolution = await pending;
  }

  /**
   * Builds the descriptor ladder from the facts the page already sent, then
   * validates it against the live page **if the live page is still the one the
   * action happened on**.
   *
   * The order matters and is the fix Task 5 could not make. Facts first, from
   * `payload.facts`: they were read inside the capture handler, in the same
   * tick as the action, so they describe the element the user acted on and
   * nothing can take that away afterwards — not a navigation, not a re-render.
   * A descriptor therefore always exists.
   *
   * Validation second, and best-effort. Proving that a candidate resolves to
   * exactly this node genuinely needs the node, so it is attempted only while
   * the document is demonstrably still there, and abandoned (not failed) the
   * moment it is not. What "still there" means is the conjunction of two cheap
   * checks: the frame's URL still equals the one captured with the action, and
   * the main-frame epoch has not advanced. Either alone has a blind spot — a
   * POST to the same URL keeps the URL, and the epoch ticks slightly after the
   * document actually changes — and both are answered from memory, with no
   * round trip to race against.
   *
   * An abandoned validation costs stability, not the step: the top facts-derived
   * candidate is reported one notch less stable, with no alternates, because
   * nothing corroborated it. Only an action that arrived with no facts at all
   * — which `buildCandidates`'s near-universal css rung makes very rare — is
   * left undescribable.
   *
   * Validation itself is `validateCandidates` (descriptor.ts), shared with
   * `computeDescriptor`: when a higher-priority rung (testId/role+name/
   * label/text) matches more than one live element, it is retried with an
   * `ordinal` recording which match `handle` was, rather than the ladder
   * falling straight through to css (Task 1: `TargetDescriptor.ordinal`).
   */
  private async compute(
    page: Page,
    payload: CapturedActionPayload,
    epoch: number,
  ): Promise<DescriptorResolution> {
    const { eid, facts, docUrl } = payload;
    const fail = (cause: ResolutionFailureCause, reason: string): DescriptorResolution => ({
      ok: false,
      cause,
      reason,
      resumePath: pathOrRaw(page.url()),
    });

    if (facts === undefined) {
      return fail("not-identifiable", "the action arrived with no element facts to describe it by");
    }

    const candidates = buildCandidates(facts);
    const top = candidates[0];
    if (top === undefined) {
      return fail(
        "not-identifiable",
        `nothing about the acted <${facts.tag}> element identifies it: no ladder rung applies`,
      );
    }

    /** The facts are trusted as they stand: unproven, so one notch less stable. */
    const unproven = (): DescriptorResolution => ({
      ok: true,
      descriptor: top.descriptor,
      stability: CAPPED_STABILITY[top.stability],
      alternates: [],
    });

    // `eid` is interpolated into a css attribute selector and arrives from the
    // page, where any script can call `window.__doitRecord` with one crafted to
    // break out of the quotes. The injected listener only ever sends a decimal
    // counter; anything else is refused rather than queried.
    if (!/^[0-9]+$/.test(eid)) {
      return fail("not-identifiable", `refusing to resolve a malformed eid: ${JSON.stringify(eid)}`);
    }

    const movedOn = (): boolean =>
      this.epoch !== epoch || (docUrl !== undefined && page.mainFrame().url() !== docUrl);

    if (movedOn()) return unproven();

    let handle: ElementHandle<Node> | null = null;
    try {
      handle = await page
        .locator(`[${EID_ATTRIBUTE}="${eid}"]`)
        .elementHandle({ timeout: RESOLVE_TIMEOUT_MS });
    } catch {
      handle = null;
    }
    // Both readings of "no handle" end the same way. The page moved on while
    // the query ran, or the element itself is gone (a menu that closed, a row
    // that re-rendered) — either way there is nothing left to prove a candidate
    // against, and the facts remain the best answer available.
    if (handle === null) return unproven();

    let passing: DescriptorCandidate[];
    try {
      if (movedOn()) return unproven();
      passing = await validateCandidates(page, candidates, handle);
    } finally {
      await handle.dispose().catch(() => undefined);
    }

    // Re-checked after the probes, and this is the guard that keeps a stale
    // resolution honest: `eid`s restart at 1 in every document, so a query left
    // over from the page we just left can match a *different* element the new
    // page has since tagged with the same number. Validating the old page's
    // facts against the new page's element would either reject a perfectly good
    // descriptor or — far worse — bless one that was proven against the wrong
    // thing. Anything learned after the document changed is discarded.
    if (movedOn()) return unproven();

    const primary = passing[0];
    if (primary === undefined) {
      // The document is still here and so is the element, and *still* no rung
      // resolves uniquely back to it. That is a real "cannot describe this",
      // not a race, and inventing an unproven descriptor for an element we can
      // see is ambiguous would produce a step that replays onto the wrong node.
      return fail(
        "not-identifiable",
        `no descriptor uniquely resolves to the acted <${facts.tag}> element ` +
          `(tried: ${candidates.map((c) => c.rung).join(", ")})`,
      );
    }

    return {
      ok: true,
      descriptor: primary.descriptor,
      stability: primary.stability,
      alternates: passing.slice(1).map((c) => c.descriptor),
    };
  }

  /** Best-effort removal of every remaining capture tag, in every live frame. */
  private async untagAll(): Promise<void> {
    try {
      await Promise.allSettled(
        this.session.page.frames().map((frame) =>
          frame.evaluate((name) => {
            for (const el of Array.from(document.querySelectorAll(`[${name}]`))) el.removeAttribute(name);
          }, EID_ATTRIBUTE),
        ),
      );
    } catch {
      // The page may already be closed. Failing to tidy up a DOM that no
      // longer exists must never cost the caller their recording.
    }
  }
}

/**
 * Kinds that become a `Step` and therefore need a target descriptor.
 * `keydown` and `submit` never do: neither becomes a step (see
 * `assemble.ts`), and resolving them would strip the `eid` tag off an element
 * the real action has not been captured for yet.
 */
const NEEDS_DESCRIPTOR: ReadonlySet<string> = new Set(["click", "input", "change"]);

/**
 * Short on purpose. This query races the consequences of the action that
 * triggered it, and waiting longer cannot improve the odds: either the tag is
 * in the current document and the query answers at once, or the document has
 * been replaced and no amount of waiting will bring the element back. The only
 * thing a generous timeout buys is a `stop()` that hangs on doomed queries —
 * and nothing is lost by giving up early, because the descriptor itself no
 * longer depends on this query, only its corroboration does.
 */
const RESOLVE_TIMEOUT_MS = 500;

/**
 * Validates what the page sent. Copies `typeAttr`/`rawText` only when present,
 * so an omitted secret value stays omitted rather than becoming `undefined`.
 */
function toPayload(raw: unknown): CapturedActionPayload | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.eid !== "string" || typeof r.tag !== "string" || typeof r.ts !== "number") return undefined;
  if (typeof r.kind !== "string" || !DOM_EVENT_KINDS.includes(r.kind)) return undefined;

  const payload: {
    eid: string;
    kind: DomEventKind;
    tag: string;
    typeAttr?: string;
    rawText?: string;
    facts?: ElementFacts;
    docUrl?: string;
    ts: number;
  } = { eid: r.eid, kind: r.kind as DomEventKind, tag: r.tag, ts: r.ts };
  if (typeof r.typeAttr === "string") payload.typeAttr = r.typeAttr;
  if (typeof r.rawText === "string") payload.rawText = r.rawText;
  if (typeof r.docUrl === "string") payload.docUrl = r.docUrl;
  const facts = toFacts(r.facts);
  if (facts !== undefined) payload.facts = facts;
  return payload;
}

/**
 * Rebuilds `ElementFacts` field by field from whatever the page sent.
 *
 * Nothing is spread through: these facts are the sole input to the descriptor
 * ladder now, they arrive over a binding any page script can call, and every
 * one of them ends up either in a persisted recording or in a locator. A field
 * of the wrong type is dropped to its neutral value rather than carried, and a
 * payload that is not an object at all yields no facts — which the caller reads
 * as "this action cannot be described", never as "describe it with junk".
 */
function toFacts(raw: unknown): ElementFacts | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  if (typeof f.tag !== "string" || f.tag === "") return undefined;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    tag: f.tag,
    roleAttr: str(f.roleAttr),
    hasHref: f.hasHref === true,
    inputType: str(f.inputType),
    selectIsMulti: f.selectIsMulti === true,
    ariaLabel: str(f.ariaLabel),
    text: str(f.text) ?? "",
    alt: str(f.alt),
    title: str(f.title),
    value: str(f.value),
    labelText: str(f.labelText),
    testId: str(f.testId),
    css: str(f.css),
  };
}
