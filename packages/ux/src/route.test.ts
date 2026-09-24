import { describe, expect, it } from "vitest";
import { routeOf } from "./route.js";

describe("routeOf — the UX screen-attribution dedupe key", () => {
  it("drops query and hash", () => {
    expect(routeOf("http://a.test/inbox?tab=1#x")).toBe("/inbox");
  });

  it("templates an all-digits id segment", () => {
    expect(routeOf("http://a.test/thread/1")).toBe("/thread/:id");
  });

  // #95/#127: `/decisions/candidate-<uuid>` instances must attribute findings to ONE screen, not
  // one per resource visited, so findings that should dedupe by (rubric item, route) actually do —
  // and a short-suffix slug (`demo-bet-1`) shares that SAME route, never a `demo-bet-:id` split.
  it("templates a prefixed id (whole segment, no literal prefix kept), so different instances share a route", () => {
    expect(routeOf("http://a.test/decisions/candidate-a1b2c3d4-e5f6-4a3b-8c1d-ef1234567890")).toBe(
      "/decisions/:id",
    );
    expect(routeOf("http://a.test/decisions/candidate-a1b2c3d4-e5f6-4a3b-8c1d-ef1234567890")).toBe(
      routeOf("http://a.test/decisions/candidate-9f8e7d6c-5b4a-4321-9876-abcdef012345"),
    );
  });

  it("falls back to a path-shaped input that is not a full URL", () => {
    expect(routeOf("/decisions/demo-bet-1?x=1")).toBe("/decisions/:id");
  });

  it("#127: demo-bet-1 and a candidate-<uuid> slug under the same prefix share a route", () => {
    expect(routeOf("http://a.test/decisions/demo-bet-1")).toBe(
      routeOf("http://a.test/decisions/candidate-a1b2c3d4-e5f6-4a3b-8c1d-ef1234567890"),
    );
  });
});
