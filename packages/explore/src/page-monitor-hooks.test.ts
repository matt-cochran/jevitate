import { EventEmitter } from "node:events";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { PageMonitor, type DeclaredField } from "./page-monitor.js";

/**
 * PageMonitor extension points:
 *  - a per-request capture hook fed the declared field NAMES and JSON TYPES of a write's body (no
 *    values), so #743 body shapes can be built without a value ever landing on `CapturedRequest`;
 *  - a settle option that discounts asset-classified requests, while a pending write still blocks.
 */

/** A minimal Playwright-Request look-alike: only the members the monitor reads. */
class FakeRequest {
  constructor(
    private readonly _url: string,
    private readonly _method: string = "GET",
    private readonly _resourceType: string = "xhr",
    private readonly _body: string | null = null,
    private readonly _headers: Record<string, string> = {},
  ) {}

  url(): string {
    return this._url;
  }
  method(): string {
    return this._method;
  }
  resourceType(): string {
    return this._resourceType;
  }
  isNavigationRequest(): boolean {
    return false;
  }
  frame(): unknown {
    return {};
  }
  headers(): Record<string, string> {
    return this._headers;
  }
  postData(): string | null {
    return this._body;
  }
}

/**
 * A page that answers the monitor's instrumentation probes and nothing else. `lastMutation` is held
 * still, so the page reads as quiet once the clock moves past the settle window.
 */
class FakePage extends EventEmitter {
  lastMutation: number;
  constructor(private readonly fake: FakeClock) {
    super();
    this.lastMutation = fake.now();
  }

  mainFrame(): unknown {
    return {};
  }
  isClosed(): boolean {
    return false;
  }
  url(): string {
    return "https://app.test/";
  }
  async addInitScript(): Promise<void> {}
  async evaluate(fnOrScript: unknown): Promise<unknown> {
    if (typeof fnOrScript === "string") return undefined;
    const source = typeof fnOrScript === "function" ? fnOrScript.toString() : "";
    if (source.includes("__jevitateMonitor")) {
      return { lastMutation: this.lastMutation, deferredUntil: 0, pageNow: this.fake.now() };
    }
    if (source.includes("querySelectorAll")) return true;
    return null;
  }
}

function setup(): { fake: FakeClock; page: FakePage; monitor: PageMonitor } {
  const fake = new FakeClock({ startMs: 1_000_000 });
  installClock(fake);
  const page = new FakePage(fake);
  const monitor = new PageMonitor(page as unknown as Page, () => fake.now());
  return { fake, page, monitor };
}

afterEach(() => resetClock());

describe("PageMonitor declared-field capture hook", () => {
  it("delivers a write body's declared field names and JSON types without any sent value", () => {
    const { page, monitor } = setup();
    const seen: DeclaredField[][] = [];
    monitor.onDeclaredFields((fields) => seen.push([...fields.fields]));

    page.emit(
      "request",
      new FakeRequest(
        "https://app.test/api/orders",
        "POST",
        "xhr",
        JSON.stringify({ orderId: 42, note: "acme-42", active: true, deletedAt: null, items: [{ sku: "SKU-1" }] }),
        { "content-type": "application/json" },
      ),
    );

    expect(seen).toEqual([
      [
        { name: "orderId", type: "number" },
        { name: "note", type: "string" },
        { name: "active", type: "boolean" },
        { name: "deletedAt", type: "null" },
        { name: "items", type: "array" },
        { name: "items.0", type: "object" },
        { name: "items.0.sku", type: "string" },
      ],
    ]);
  });

  it("omits a field whose declared name matches the credential rule", () => {
    const { page, monitor } = setup();
    const seen: DeclaredField[][] = [];
    monitor.onDeclaredFields((fields) => seen.push([...fields.fields]));

    page.emit(
      "request",
      new FakeRequest("https://app.test/api/login", "POST", "xhr", JSON.stringify({ orderId: 42, password: "hunter2-long" }), {
        "content-type": "application/json",
      }),
    );

    expect(seen).toEqual([[{ name: "orderId", type: "number" }]]);
  });

  it("reads a form body's declared fields as string types", () => {
    const { page, monitor } = setup();
    const seen: DeclaredField[][] = [];
    monitor.onDeclaredFields((fields) => seen.push([...fields.fields]));

    page.emit(
      "request",
      new FakeRequest("https://app.test/api/orders", "POST", "xhr", "orderId=42&note=acme-42", {
        "content-type": "application/x-www-form-urlencoded",
      }),
    );

    expect(seen).toEqual([
      [
        { name: "orderId", type: "string" },
        { name: "note", type: "string" },
      ],
    ]);
  });

  it("stores no sent body value on the captured request record", () => {
    const { page, monitor } = setup();
    monitor.onDeclaredFields(() => {});
    const capture = monitor.startCapture();

    page.emit(
      "request",
      new FakeRequest("https://app.test/api/orders", "POST", "xhr", JSON.stringify({ note: "acme-42" }), {
        "content-type": "application/json",
      }),
    );

    expect(JSON.stringify(capture.sent())).not.toContain("acme-42");
  });
});

describe("PageMonitor settle asset discount", () => {
  it("settles while an asset request is pending when discountAssets is set", async () => {
    const { fake, page, monitor } = setup();
    page.emit("request", new FakeRequest("https://app.test/assets/logo.png", "GET", "image"));

    const waited = monitor.waitSettled({ quietMs: 100, ceilingMs: 1_000, discountAssets: true });
    await fake.runUntilIdle();

    expect((await waited).settled).toBe(true);
  });

  it("still waits for a pending write when discountAssets is set", async () => {
    const { fake, page, monitor } = setup();
    page.emit(
      "request",
      new FakeRequest("https://app.test/api/save", "POST", "xhr", JSON.stringify({ name: "Ada Lovelace" }), {
        "content-type": "application/json",
      }),
    );

    const waited = monitor.waitSettled({ quietMs: 100, ceilingMs: 1_000, discountAssets: true });
    await fake.runUntilIdle();

    expect((await waited).settled).toBe(false);
  });

  it("waits for a pending asset request when discountAssets is not set", async () => {
    const { fake, page, monitor } = setup();
    page.emit("request", new FakeRequest("https://app.test/assets/logo.png", "GET", "image"));

    const waited = monitor.waitSettled({ quietMs: 100, ceilingMs: 1_000 });
    await fake.runUntilIdle();

    expect((await waited).settled).toBe(false);
  });
});
