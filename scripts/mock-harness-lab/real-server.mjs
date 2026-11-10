#!/usr/bin/env node
// The lab's "real stack": a synthetic stand-in for Journeeze's triage surface (#802). A stateful
// gRPC-Web backend (TriageService: ListClusters, GetCluster, FileIssue) plus the SPA that drives it.
// It is NOT Journeeze: ~/working/journeeze-saas is off limits and nothing gRPC-Web from it was ever
// copied into the jevitate repo or .delivery, so the shapes here are invented to match the Journey
// `jz-triager-files-issue` as the 0.29.0 report describes it (click a cluster card, file an issue).
//
// Per-process secrets (session cookie, CSRF token) are random, so a recording of a real run carries
// values the redactor must remove and the scanner can look for exactly.
//
// Usage: node real-server.mjs --port 28190 [--drift] [--secrets-out <file>]
//   POST /__lab/reset   restore the seed (no issue filed, issue counter back to 41)
//   --drift             FileIssue requires a new `severity` field (an API change the mock never saw)
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clock } from "../../packages/domain/dist/index.js";
import { decode, encode, parseBody, responseBody } from "./proto.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i < 0 ? dflt : args[i + 1];
};
const port = Number(opt("--port", "28190"));
const drift = args.includes("--drift");
const secretsOut = opt("--secrets-out", undefined);

const csrf = randomBytes(24).toString("hex");
const sessions = new Set();
const issued = [];

function seed() {
  return {
    nextIssue: 42,
    clusters: [
      { id: "cl_checkout", title: "Checkout button broken", reports: 2, issueNumber: 0, issueUrl: "", reporterEmail: "dana.reporter@customer-co.test", updatedAt: "2026-11-05T10:00:00Z" },
      { id: "cl_search", title: "Search returns stale results", reports: 1, issueNumber: 0, issueUrl: "", reporterEmail: "lee.ops@customer-co.test", updatedAt: "2026-11-05T11:00:00Z" },
    ],
  };
}
let db = seed();

const proto = readFileSync(join(here, "proto.js"), "utf8");
const page = readFileSync(join(here, "app.html"), "utf8");

function newSession() {
  const s = `jzs_${randomBytes(20).toString("hex")}`;
  sessions.add(s);
  issued.push(s);
  if (secretsOut) writeFileSync(secretsOut, JSON.stringify({ csrf, sessions: issued }), { mode: 0o600 });
  return s;
}
if (secretsOut) writeFileSync(secretsOut, JSON.stringify({ csrf, sessions: issued }), { mode: 0o600 });

function cookieOf(req) {
  const m = /(?:^|;\s*)jz_session=([^;]+)/.exec(req.headers.cookie ?? "");
  return m?.[1];
}

const grpcHeaders = { "content-type": "application/grpc-web+proto", "access-control-expose-headers": "grpc-status,grpc-message" };

function rpc(method, body) {
  const { data } = parseBody(body);
  if (method === "ListClusters") return { type: "ListClustersResponse", msg: { clusters: db.clusters } };
  if (method === "GetCluster") {
    const { id } = decode("GetClusterRequest", data);
    const c = db.clusters.find((x) => x.id === id);
    return c ? { type: "GetClusterResponse", msg: { cluster: c } } : { status: 5, message: "cluster not found" };
  }
  if (method === "FileIssue") {
    const r = decode("FileIssueRequest", data);
    const c = db.clusters.find((x) => x.id === r.clusterId);
    if (!c) return { status: 5, message: "cluster not found" };
    if (drift && !r.severity) return { status: 3, message: "severity is required" };
    if (c.issueNumber) return { status: 6, message: "issue already filed" };
    c.issueNumber = db.nextIssue++;
    c.issueUrl = `https://github.example.test/acme/shop/issues/${c.issueNumber}`;
    c.updatedAt = clock.nowIso();
    return { type: "FileIssueResponse", msg: { issueNumber: c.issueNumber, issueUrl: c.issueUrl } };
  }
  return { status: 12, message: "unimplemented" };
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = new Uint8Array(Buffer.concat(chunks));
    if (req.method === "POST" && path === "/__lab/reset") {
      db = seed();
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && path === "/proto.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(proto);
      return;
    }
    if (req.method === "GET" && (path === "/triage" || path.startsWith("/triage/"))) {
      const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
      if (!sessions.has(cookieOf(req) ?? "")) headers["set-cookie"] = `jz_session=${newSession()}; Path=/; HttpOnly; SameSite=Lax`;
      res.writeHead(200, headers).end(page.replace("__CSRF__", csrf));
      return;
    }
    const m = /^\/journeeze\.v1\.TriageService\/(\w+)$/.exec(path);
    if (req.method === "POST" && m) {
      if (!sessions.has(cookieOf(req) ?? "") || req.headers["x-csrf-token"] !== csrf) {
        res.writeHead(200, grpcHeaders).end(Buffer.from(responseBody(new Uint8Array(0), 16, "unauthenticated")));
        return;
      }
      const out = rpc(m[1], body);
      const bytes = out.status ? responseBody(new Uint8Array(0), out.status, out.message) : responseBody(encode(out.type, out.msg));
      res.writeHead(200, grpcHeaders).end(Buffer.from(bytes));
      return;
    }
    res.writeHead(404).end();
  });
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`real-server ready http://127.0.0.1:${port}${drift ? " (drift)" : ""}\n`));
