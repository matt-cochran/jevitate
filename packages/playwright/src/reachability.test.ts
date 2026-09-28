import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { probeReachable } from "./reachability.js";

/** A fake socket that emits `event` (with `payload`) on the next tick, or never. */
function fakeSocket(event?: "connect" | "error", payload?: unknown): () => Socket {
  return () => {
    const s = new EventEmitter() as EventEmitter & { destroy(): void };
    s.destroy = () => undefined;
    if (event !== undefined) setImmediate(() => s.emit(event, payload));
    return s as unknown as Socket;
  };
}

describe("probeReachable (#213: fail fast when nothing is listening)", () => {
  it("a refused connect is 'connection refused — is the app running at <origin>?'", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const r = await probeReachable("http://127.0.0.1:59123/app", { connect: fakeSocket("error", err) });
    expect(r).toBe("connection refused — is the app running at http://127.0.0.1:59123?");
  });

  it("a loopback connect that is never answered (WSL drops the SYN) fails within the short bound, not 30s", async () => {
    const t0 = Date.now();
    const r = await probeReachable("http://localhost:59123/", { connect: fakeSocket(), loopbackTimeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatch(/^connection refused \(nothing answered a connect within 0s\) — is the app running at http:\/\/localhost:59123\?$/);
  });

  it("an unknown host is 'host not found'", async () => {
    const lookup = () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    const r = await probeReachable("https://nosuch.example.invalid/", { lookup, connect: fakeSocket("connect") });
    expect(r).toBe("host not found (nosuch.example.invalid) — is the app running at https://nosuch.example.invalid?");
  });

  it("a listening server is reachable (null), and a non-http URL is never probed", async () => {
    const srv = createServer((s) => s.end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await probeReachable(`http://127.0.0.1:${port}/`)).toBeNull();
    } finally {
      srv.close();
    }
    expect(await probeReachable("about:blank")).toBeNull();
    expect(await probeReachable("not a url")).toBeNull();
  });
});
