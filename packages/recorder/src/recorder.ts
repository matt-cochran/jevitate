import type { Frame } from "playwright";
import type { BrowserSession } from "@doit/playwright";
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

export interface ActionCaptureEvent {
  readonly type: "action";
  /** Monotonic arrival order within this Recorder. */
  readonly seq: number;
  /** Node-side receive time; diagnostic only (includes IPC latency). */
  readonly receivedAt: number;
  /** URL of the frame the action happened in. */
  readonly frameUrl: string;
  readonly payload: CapturedActionPayload;
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
 * Installs in-page capture on a `BrowserSession` and buffers what it reports.
 *
 * Transport: `page.addInitScript` injects the listener into every document of
 * every frame; `page.exposeBinding` receives each action; `framenavigated`
 * records navigations Node-side (they are not observed in the page), which is
 * what later tasks split into `PageSegment`s.
 *
 * `eid`s are unique within a document: each navigation starts a fresh `window`
 * and therefore a fresh counter. Buffered events carry `frameUrl` and `seq`
 * alongside the interleaved navigation events, so a consumer disambiguates an
 * `eid` by the segment it falls in.
 */
export class Recorder {
  private readonly buffer: CaptureEvent[] = [];
  private seq = 0;
  private installed = false;

  constructor(private readonly session: BrowserSession) {}

  /** Idempotent: `exposeBinding` would throw if registered twice. */
  async install(): Promise<void> {
    if (this.installed) return;
    this.installed = true;
    const page = this.session.page;

    await page.exposeBinding(RECORD_BINDING, (source: { frame: Frame }, payload: unknown) => {
      this.onAction(source.frame.url(), payload);
    });
    await page.addInitScript(installRecorderListener);

    page.on("framenavigated", (frame: Frame) => {
      this.buffer.push({
        type: "navigation",
        seq: this.seq++,
        receivedAt: Date.now(),
        url: frame.url(),
        isMainFrame: frame === page.mainFrame(),
      });
    });
  }

  /** Everything captured so far, in arrival order. */
  get events(): readonly CaptureEvent[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  private onAction(frameUrl: string, raw: unknown): void {
    const payload = toPayload(raw);
    if (payload === undefined) return;
    this.buffer.push({ type: "action", seq: this.seq++, receivedAt: Date.now(), frameUrl, payload });
  }
}

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
