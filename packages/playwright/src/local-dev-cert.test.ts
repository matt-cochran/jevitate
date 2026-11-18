import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  LocalDevCertError,
  localDevCertLaunchArgs,
  parseLocalDevCertOrigin,
  spkiPinOf,
} from "./local-dev-cert.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../test-fixtures/local-dev-cert/${name}`, import.meta.url)), "utf8");

/** The fixture certificate's own SPKI pin, computed independently of the code under test. */
const fixturePin = (): string =>
  createHash("sha256")
    .update(new X509Certificate(fixture("cert.pem")).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");

describe("parseLocalDevCertOrigin", () => {
  test("accepts an https localhost origin", () => {
    expect(parseLocalDevCertOrigin("https://localhost:5173")).toBe("https://localhost:5173");
  });

  test("accepts an https 127.0.0.1 origin", () => {
    expect(parseLocalDevCertOrigin("https://127.0.0.1:8443")).toBe("https://127.0.0.1:8443");
  });

  test("accepts any 127.0.0.0/8 address", () => {
    expect(parseLocalDevCertOrigin("https://127.1.2.3:8443")).toBe("https://127.1.2.3:8443");
  });

  test("accepts an https [::1] origin", () => {
    expect(parseLocalDevCertOrigin("https://[::1]:8443")).toBe("https://[::1]:8443");
  });

  test("reduces a URL with a path to its origin", () => {
    expect(parseLocalDevCertOrigin("https://localhost:5173/app?x=1")).toBe("https://localhost:5173");
  });

  test("refuses plain http (there is no certificate to accept)", () => {
    expect(() => parseLocalDevCertOrigin("http://localhost:5173")).toThrow(/https/);
  });

  test("refuses a public host", () => {
    expect(() => parseLocalDevCertOrigin("https://example.com")).toThrow(/loopback/);
  });

  test("refuses a host that only starts like a loopback address", () => {
    expect(() => parseLocalDevCertOrigin("https://127.0.0.1.nip.io")).toThrow(/loopback/);
  });

  test("refuses a host that only starts with localhost", () => {
    expect(() => parseLocalDevCertOrigin("https://localhost.example.com")).toThrow(/loopback/);
  });

  test("refuses text that is not a URL", () => {
    expect(() => parseLocalDevCertOrigin("localhost:5173")).toThrow(/origin/);
  });
});

describe("spkiPinOf", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer({ key: fixture("key.pem"), cert: fixture("cert.pem") }, (_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("reads the SHA-256 SPKI pin of the server's certificate", async () => {
    expect(await spkiPinOf(origin)).toBe(fixturePin());
  });

  test("a server that is not listening is a LocalDevCertError naming the origin", async () => {
    await expect(spkiPinOf("https://127.0.0.1:1", { timeoutMs: 2000 })).rejects.toThrow(LocalDevCertError);
  });
});

describe("localDevCertLaunchArgs", () => {
  test("no origins → no launch args", async () => {
    expect(await localDevCertLaunchArgs([], async () => "unused")).toEqual([]);
  });

  test("pins every origin's key in one Chromium switch", async () => {
    const pins: Record<string, string> = { "https://localhost:5173": "AAA=", "https://127.0.0.1:8443": "BBB=" };
    const args = await localDevCertLaunchArgs(["https://localhost:5173", "https://127.0.0.1:8443"], async (o) => pins[o] ?? "");
    expect(args).toEqual(["--ignore-certificate-errors-spki-list=AAA=,BBB="]);
  });

  test("two origins with the same key are pinned once", async () => {
    const args = await localDevCertLaunchArgs(["https://localhost:5173", "https://127.0.0.1:5173"], async () => "SAME=");
    expect(args).toEqual(["--ignore-certificate-errors-spki-list=SAME="]);
  });
});
