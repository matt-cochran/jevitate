// #800 witness lab: the accuracy lab's Acme CRM behind a stable origin that can be RESET.
//
// The lab app keeps its state in memory per server, so a reset is "start a fresh inner server".
// This module serves a fixed public origin and proxies to the current inner server; a SEPARATE
// control port (never handed to the browser) answers POST /reset by swapping in a fresh inner
// server. A mutation proof's --before hook calls it (reset.mjs) before every replay, which is what
// makes the lab a "resettable target" in the design's sense (§0, #792).
import { createServer, request } from "node:http";
import { startAccuracyLab } from "../../test/fixtures/accuracy-lab/app.mjs";

const listen = (server) =>
  new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });

/** Start the variant behind a resettable origin. Resolves { origin, controlPort, resets(), close() }. */
export async function startResettableLab(variant) {
  let inner = await startAccuracyLab({ variant, port: 0 });
  let resets = 0;

  const publicServer = createServer((req, res) => {
    const upstream = request(
      { host: "127.0.0.1", port: inner.port, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  const controlServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/reset") {
      const old = inner;
      inner = await startAccuracyLab({ variant, port: 0 });
      resets += 1;
      await old.close();
      res.writeHead(200, { "content-type": "text/plain" }).end("reset\n");
      return;
    }
    res.writeHead(404).end();
  });

  const port = await listen(publicServer);
  const controlPort = await listen(controlServer);
  return {
    origin: `http://127.0.0.1:${port}`,
    controlPort,
    resets: () => resets,
    close: async () => {
      publicServer.closeAllConnections?.();
      controlServer.closeAllConnections?.();
      await Promise.all([
        new Promise((r) => publicServer.close(() => r())),
        new Promise((r) => controlServer.close(() => r())),
        inner.close(),
      ]);
    },
  };
}
