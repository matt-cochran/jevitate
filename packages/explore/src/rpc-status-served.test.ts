import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clock } from "@jevitate/domain";
import { monitorFor, type RequestCapture } from "./page-monitor.js";
import { Http5xxOracle } from "./http-5xx.js";
import { evaluateNetworkCheck } from "./success-checks.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #378, served in real Chromium: a fake gRPC-web backend answers HTTP 200 for every RPC; the real
 * result is `grpc-status` — in the body's trailer frame (binary or base64 `-text`) or, for a
 * trailers-only response, a header. `responseStatus:…=2xx` must not hold for a failed RPC, the
 * HTTP 5xx hard signal fires for a server-side failure (INTERNAL / UNAVAILABLE), and an OK RPC holds.
 */

function frame(flag: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head[0] = flag;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
const reply = (code: number): Buffer =>
  Buffer.concat([frame(0x00, Buffer.from([0x0a, 0x02, 0x68, 0x69])), frame(0x80, Buffer.from(`grpc-status: ${code}\r\ngrpc-message: secret-ish detail\r\n`))]);

const PAGE = `<!doctype html><html><body><main><h1>RPC</h1></main><script>
  const call = (m) => fetch("/pkg.Svc/" + m, { method: "POST", headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1" }, body: "x" })
    .then((r) => r.arrayBuffer());
  Promise.all(["Method", "Ok", "Text", "Denied"].map(call)).then(() => { window.done = true; });
</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    req.resume();
    if (url === "/pkg.Svc/Method") return void res.writeHead(200, { "content-type": "application/grpc-web+proto" }).end(reply(13));
    if (url === "/pkg.Svc/Ok") return void res.writeHead(200, { "content-type": "application/grpc-web+proto" }).end(reply(0));
    if (url === "/pkg.Svc/Text") return void res.writeHead(200, { "content-type": "application/grpc-web-text+proto" }).end(reply(14).toString("base64"));
    if (url === "/pkg.Svc/Denied") {
      // Trailers-only: the status rides in the response headers, the body is empty.
      return void res.writeHead(200, { "content-type": "application/grpc-web+proto", "grpc-status": "7", "grpc-message": "nope" }).end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function finishedRpcs(capture: RequestCapture, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (capture.requests().filter((r) => r.path.startsWith("/pkg.Svc/")).length >= n) return;
    await clock.sleep(10);
  }
}

describe("#378 gRPC-web status (served)", () => {
  it("judges each RPC by its grpc-status: trailer frame (binary, text) or trailers-only header", async () => {
    await withSession(
      "rpc-status-",
      async (session) => {
        const page = session.page;
        const capture = monitorFor(page).startCapture();
        const oracle = new Http5xxOracle(page, { allowlist: [origin] });
        await page.goto(`${origin}/`);
        await page.waitForFunction("window.done === true");
        await finishedRpcs(capture, 4);
        const requests = capture.requests();
        const byPath = (p: string) => requests.find((r) => r.path === p);
        expect(byPath("/pkg.Svc/Method")).toMatchObject({ status: 200, rpcStatus: { protocol: "grpc-web", code: 13, name: "internal" } });
        expect(byPath("/pkg.Svc/Ok")).toMatchObject({ status: 200, rpcStatus: { code: 0 } });
        expect(byPath("/pkg.Svc/Text")).toMatchObject({ status: 200, rpcStatus: { code: 14, name: "unavailable" } });
        expect(byPath("/pkg.Svc/Denied")).toMatchObject({ status: 200, rpcStatus: { code: 7, name: "permission_denied" } });
        // Only the status CODE is kept: never grpc-message, never a body byte.
        expect(JSON.stringify(requests)).not.toContain("secret-ish");
        expect(JSON.stringify(requests)).not.toContain("nope");

        const failed = evaluateNetworkCheck({ kind: "responseStatus", method: "POST", pathGlob: "/pkg.Svc/Method", status: { class: 2 } }, capture.sent());
        expect(failed.passed).toBe(false);
        expect(failed.detail).toContain("200 (grpc-status 13 internal)");
        expect(evaluateNetworkCheck({ kind: "responseStatus", method: "POST", pathGlob: "/pkg.Svc/Ok", status: { class: 2 } }, capture.sent()).passed).toBe(true);
        expect(evaluateNetworkCheck({ kind: "responseStatus", method: "POST", pathGlob: "/pkg.Svc/Denied", status: { class: 4 } }, capture.sent()).passed).toBe(true);
        expect(evaluateNetworkCheck({ kind: "requestMade", method: "POST", pathGlob: "/pkg.Svc/Method" }, capture.sent()).passed).toBe(true);

        // The HTTP 5xx hard signal: INTERNAL (→ 500) and UNAVAILABLE (→ 503) are defects; OK and a
        // client-side refusal (PERMISSION_DENIED → 403) are not.
        for (let i = 0; i < 400 && oracle.count < 2; i++) await clock.sleep(10);
        oracle.noteStep({ step: 1 });
        const defects = oracle.defects([{ step: 1, actOk: true }]);
        const seen = defects.map((d) => ({ url: new URL(d.signals[0]!.url).pathname, status: d.signals[0]!.status }));
        expect(seen.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
          { url: "/pkg.Svc/Method", status: 500 },
          { url: "/pkg.Svc/Text", status: 503 },
        ]);
        expect(defects.find((d) => d.signals[0]!.url.endsWith("/pkg.Svc/Method"))?.signals[0]?.detail).toContain("HTTP 200, grpc-status 13 internal");
      },
      origin,
    );
  });
});
