#!/usr/bin/env node
// #800 witness lab: the operator reset hook. `node reset.mjs <controlPort>` asks lab-target.mjs to
// swap in a fresh inner server (in-memory state back to its seed). Exit 0 on reset, 1 otherwise.
import { request } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write("usage: node reset.mjs <controlPort>\n");
  process.exit(2);
}
const req = request({ host: "127.0.0.1", port, method: "POST", path: "/reset" }, (res) => {
  res.resume();
  res.on("end", () => process.exit(res.statusCode === 200 ? 0 : 1));
});
req.on("error", () => process.exit(1));
req.end();
