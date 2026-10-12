import { describe, expect, it } from "vitest";
import { detectAllowOriginMismatch, findAllowOriginMismatches } from "./allow-origin-mismatch.js";

/** #484: a blocked loopback write whose origin is the allowed one spelled differently, or on a port --allow misses. */
describe("detectAllowOriginMismatch (#484)", () => {
  it("names the allowed localhost origin when the blocked write went to 127.0.0.1 on the same port", () => {
    expect(detectAllowOriginMismatch("http://127.0.0.1:3000/api/upload", ["http://localhost:3000"])?.allowedOrigin).toBe("http://localhost:3000");
  });

  it("flags the reverse spelling: localhost blocked while 127.0.0.1 is allowed", () => {
    expect(detectAllowOriginMismatch("http://localhost:8080", ["http://127.0.0.1:8080"])?.kind).toBe("loopback-spelling");
  });

  it("flags a loopback port --allow misses when the start URL is loopback", () => {
    expect(detectAllowOriginMismatch("http://localhost:4000/graphql", ["http://localhost:3000"], { startUrl: "http://localhost:3000/app" })?.kind).toBe(
      "loopback-port",
    );
  });

  it("stays silent on a loopback port --allow misses when the start URL is not loopback", () => {
    expect(detectAllowOriginMismatch("http://localhost:4000", ["https://app.example.com"], { startUrl: "https://app.example.com/" })).toBeNull();
  });

  it("stays silent on a non-loopback blocked origin", () => {
    expect(detectAllowOriginMismatch("https://api.example.com/x", ["http://localhost:3000"], { startUrl: "http://localhost:3000/" })).toBeNull();
  });

  it("stays silent when the blocked origin is itself allowed", () => {
    expect(detectAllowOriginMismatch("http://127.0.0.1:3000/x", ["http://127.0.0.1:3000"], { startUrl: "http://127.0.0.1:3000/" })).toBeNull();
  });

  it("tells the operator which origin to add to --allow", () => {
    expect(detectAllowOriginMismatch("http://127.0.0.1:3000/api", ["http://localhost:3000"])?.message).toContain("--allow http://localhost:3000 --allow http://127.0.0.1:3000");
  });

  it("#508: with no allow list, the loopback-port hint names the start origin plus the blocked one", () => {
    expect(detectAllowOriginMismatch("http://localhost:8080/x", [], { startUrl: "http://localhost:8090/" })?.message).toContain(
      "add both to --allow: --allow http://localhost:8090 --allow http://localhost:8080",
    );
  });

  it("#508: with an allow list, the loopback-port hint prints the existing list plus the blocked origin", () => {
    expect(detectAllowOriginMismatch("http://localhost:8080/x", ["http://localhost:8090"], { startUrl: "http://localhost:8090/" })?.message).toContain(
      "--allow http://localhost:8090 --allow http://localhost:8080",
    );
  });

  it("reports each mismatched origin once across many requests", () => {
    const found = findAllowOriginMismatches(["http://127.0.0.1:3000/a", "http://127.0.0.1:3000/b", "https://cdn.example.com/c"], ["http://localhost:3000"]);
    expect(found.map((m) => m.blockedOrigin)).toEqual(["http://127.0.0.1:3000"]);
  });
});
