import type { Frame, Page } from "playwright";
import type { BrowserSession } from "@doit/playwright";
import type { Recording, TargetDescriptor } from "@doit/recording";
import { assembleRecording, pathOrRaw } from "./assemble.js";
import { computeDescriptor, EID_ATTRIBUTE, type Stability } from "./descriptor.js";
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
  /** Page-side `Date.now()` — authoritative for ordering and timing. */
  readonly ts: number;
}

/**
 * The outcome of resolving a captured `eid` back to a live element and
 * computing its descriptor. Computed **while the recording is running**, not at
 * `stop()` time — see `Recorder.resolve`.
 */
export type DescriptorResolution =
  | {
      readonly ok: true;
      readonly descriptor: TargetDescriptor;
      readonly stability: Stability;
      readonly alternates: readonly TargetDescriptor[];
    }
  | {
      readonly ok: false;
      /** Why no descriptor could be computed; diagnostic, and surfaced in review. */
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
   * synchronously so the buffer preserves true arrival order; the DOM round
   * trip that computes the descriptor cannot be synchronous, so it fills this
   * in a moment later. `undefined` means the descriptor was never attempted —
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
 *  2. `start()`…`stop()` is a recording. Each action's descriptor is computed
 *     **as it arrives**, not at the end — by `stop()` the journey has crossed
 *     several documents and `[data-doit-eid=N]` cannot be resolved on a page
 *     that was navigated away from three steps ago. Resolving per action also
 *     disposes of the "an `eid` is only unique per document" hazard.
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
    this.recording = false;
    // An action captured a moment before `stop()` may still be resolving its
    // descriptor; assembling without it would silently demote a real step to
    // a handback.
    await Promise.allSettled([...this.inFlight]);
    // The capture tags exist only for the duration of a recording (`compute`
    // puts back the one it consumed so a field stays recognizable across its
    // own events). Now that no further event can arrive, the page the user is
    // still looking at gets its DOM back.
    await this.untagAll();
    return assembleRecording(this.buffer, {
      site: this.site,
      startedAtIso: this.startedAtIso,
      intent: this.intent,
      retro,
    });
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
   * Resolves `payload.eid` back to the live element and computes its
   * descriptor — **now, while the recording is running**, not at `stop()`.
   *
   * This is the whole reason capture and assembly are split the way they are.
   * By the time `stop()` runs, the user has demonstrated a journey across
   * several documents, and `[data-doit-eid=N]` cannot be resolved on a page
   * that was navigated away from three steps ago. Resolving per action also
   * disposes of the "an `eid` is only unique per document" hazard: the tag is
   * read and stripped before the page's counter can hand the same number to a
   * different element.
   *
   * Never throws. A failure is recorded as data (`{ok: false}`) and becomes a
   * `handback` at assembly time, because "this action is not reliably
   * replayable" is a fact about the recording, not an error in taking it.
   *
   * KNOWN LIMITATION — an action that destroys its own document cannot be
   * described. A click on a submit button (or a link) starts a navigation
   * immediately; the new document commits in tens of milliseconds, while
   * describing the clicked element needs a `locator.elementHandle`, an
   * `evaluate` for the element's facts and a uniqueness-plus-identity probe per
   * ladder rung — measured at 700–2100ms cold and well over the commit time
   * even warm. The query then runs against the *new* document, finds no
   * `data-doit-eid`, and the step degrades to a `handback`.
   *
   * Pausing the navigation request with `page.route` was tried and does not
   * work: while a navigation is pending Playwright's locator auto-waiting
   * blocks, so holding the request also holds every query the description
   * needs (measured: 4 of 5 descriptions still unfinished after a 10s hold).
   * A real fix has to capture the element's facts **in the page, synchronously,
   * inside the capture listener** — i.e. in `inject.ts`/`descriptor.ts`, not
   * here. Escalated rather than worked around; see the task-5 report.
   */
  private async resolve(source: { page: Page; frame: Frame }, event: ActionCaptureEvent): Promise<void> {
    const page = this.session.page;
    const { eid } = event.payload;
    const epoch = this.epoch;
    const key = `${epoch}:${eid}`;

    if (source.frame !== source.page.mainFrame()) {
      // Descriptor computation is main-frame only (`computeDescriptor` queries
      // the page, not the frame), so a sub-frame action is routed to a human
      // rather than described wrongly.
      event.resolution = {
        ok: false,
        reason: "action happened in a sub-frame; descriptor computation is main-frame only",
        resumePath: pathOrRaw(source.page.url()),
      };
      return;
    }

    // Registered *before* the first await, so every event for this element
    // that arrives while the computation is running shares it rather than
    // starting a doomed second one against an already-stripped tag.
    let pending = this.resolutions.get(key);
    if (pending === undefined) {
      pending = this.compute(page, eid);
      this.resolutions.set(key, pending);
    }
    event.resolution = await pending;
  }

  private async compute(page: Page, eid: string): Promise<DescriptorResolution> {
    const fail = (reason: string): DescriptorResolution => ({
      ok: false,
      reason,
      resumePath: pathOrRaw(page.url()),
    });

    // The `eid` is interpolated into a css attribute selector, and it arrives
    // from the page — where any script can call `window.__doitRecord` with an
    // `eid` crafted to break out of the quotes. The injected listener only ever
    // sends a decimal counter, so anything else is refused outright.
    if (!/^[0-9]+$/.test(eid)) return fail(`refusing to resolve a malformed eid: ${JSON.stringify(eid)}`);

    let handle;
    try {
      handle = await page
        .locator(`[${EID_ATTRIBUTE}="${eid}"]`)
        .elementHandle({ timeout: RESOLVE_TIMEOUT_MS });
    } catch (err) {
      return fail(`could not resolve ${EID_ATTRIBUTE}="${eid}": ${messageOf(err)}`);
    }
    if (handle === null) return fail(`no element carries ${EID_ATTRIBUTE}="${eid}" any more`);

    try {
      const computed = await computeDescriptor(page, handle);
      return {
        ok: true,
        descriptor: computed.descriptor,
        stability: computed.stability,
        alternates: computed.alternates,
      };
    } catch (err) {
      return fail(messageOf(err));
    } finally {
      // Put the capture tag back. `computeDescriptor` strips it — correctly, as
      // cleanup — but the recording is still running, and Task 3's in-page
      // listener only reuses an `eid` while the attribute is still on the
      // element: strip it and the field's next event (the blur-time `change`,
      // or the next keystroke) mints a *fresh* `eid`, which reads as a second,
      // different element and duplicates the step. `stop()` does the real
      // cleanup, once, when no further events can arrive.
      await handle
        .evaluate((node, [name, value]) => {
          (node as Element).setAttribute(name!, value!);
        }, [EID_ATTRIBUTE, eid])
        .catch(() => undefined);
      await handle.dispose().catch(() => undefined);
    }
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
 * Short on purpose. This resolution races the consequences of the action that
 * triggered it, and waiting longer cannot improve the odds: either the tag is
 * in the current document and the query answers at once, or the document has
 * been replaced and no amount of waiting will bring the element back. The only
 * thing a generous timeout buys is a `stop()` that hangs on doomed queries.
 */
const RESOLVE_TIMEOUT_MS = 500;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    ts: number;
  } = { eid: r.eid, kind: r.kind as DomEventKind, tag: r.tag, ts: r.ts };
  if (typeof r.typeAttr === "string") payload.typeAttr = r.typeAttr;
  if (typeof r.rawText === "string") payload.rawText = r.rawText;
  return payload;
}
