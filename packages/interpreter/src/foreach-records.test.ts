import { expect, test, vi } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { runStep } from "./run-step.js";

// #580: a discover Journey walks open conversations with `forEach` and one
// `extract` per record field. Alongside the long-standing row-scoped binding
// (`<field>`, last row wins) the interpreter must publish every row under an
// indexed binding (`<as>.<i>.<field>`) and the row count (`<as>.count`).

function fakeLocator(overrides: Partial<Record<string, any>> = {}) {
  return {
    click: vi.fn(async () => {}),
    innerText: vi.fn(async () => ""),
    isVisible: vi.fn(async () => true),
    // One match: the recorded target resolves uniquely (replay refuses anything else).
    count: vi.fn(async () => 1),
    waitFor: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeRowRoot(leaf: ReturnType<typeof fakeLocator>) {
  return {
    getByTestId: vi.fn(() => leaf),
    getByRole: vi.fn(() => leaf),
    getByLabel: vi.fn(() => leaf),
    getByText: vi.fn(() => leaf),
    locator: vi.fn(() => leaf),
  };
}

function fakeItemsLocator(rows: any[]) {
  return { count: vi.fn(async () => rows.length), nth: vi.fn((i: number) => rows[i]) };
}

function fakePageReturning(itemsLocator: any) {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.test/inbox"),
    getByTestId: vi.fn(() => itemsLocator),
    getByRole: vi.fn(() => itemsLocator),
    getByLabel: vi.fn(() => itemsLocator),
    getByText: vi.fn(() => itemsLocator),
    locator: vi.fn(() => itemsLocator),
  };
}

function actorWithPage(page: any) {
  return CastActor.named("test").whoCan(
    new BrowseTheWeb({ page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []),
  );
}

function rowsFor(values: string[]): { itemsLocator: any; actor: any } {
  const rows = values.map((value) => fakeRowRoot(fakeLocator({ innerText: vi.fn(async () => value) })));
  const itemsLocator = fakeItemsLocator(rows);
  return { itemsLocator, actor: actorWithPage(fakePageReturning(itemsLocator)) };
}

function extractRecordsStep(children: RecordedStep["step"][]) {
  const rec: RecordedStep = {
    step: { kind: "forEach", items: { testId: "rows" }, as: "records", steps: children as any },
  };
  return rec;
}

test("forEach publishes each row's extracted value under records.<i>.<field>", async () => {
  const { actor } = rowsFor(["c-1001", "c-2002"]);
  const vars = new Map<string, string>();
  const rec = extractRecordsStep([
    { kind: "extract", target: { testId: "commentId" }, as: "commentId", expect: { kind: "visible", target: { testId: "commentId" } } } as any,
  ]);

  await runStep(actor, rec, vars);

  expect([vars.get("records.0.commentId"), vars.get("records.1.commentId")]).toEqual(["c-1001", "c-2002"]);
});

test("forEach publishes the row count under records.count as a decimal string", async () => {
  const { actor } = rowsFor(["c-1001", "c-2002", "c-3003"]);
  const vars = new Map<string, string>();
  const rec = extractRecordsStep([
    { kind: "extract", target: { testId: "commentId" }, as: "commentId", expect: { kind: "visible", target: { testId: "commentId" } } } as any,
  ]);

  await runStep(actor, rec, vars);

  expect(vars.get("records.count")).toBe("3");
});

test("forEach keeps the existing row-scoped extract binding at the last row's value", async () => {
  const { actor } = rowsFor(["c-1001", "c-2002"]);
  const vars = new Map<string, string>();
  const rec = extractRecordsStep([
    { kind: "extract", target: { testId: "commentId" }, as: "commentId", expect: { kind: "visible", target: { testId: "commentId" } } } as any,
  ]);

  await runStep(actor, rec, vars);

  expect(vars.get("commentId")).toBe("c-2002");
});

test("forEach publishes every extracted field of a row under that row's index", async () => {
  const leaf = fakeLocator({ innerText: vi.fn(async () => "c-1001") });
  const row0 = fakeRowRoot(leaf);
  const itemsLocator = fakeItemsLocator([row0]);
  const actor = actorWithPage(fakePageReturning(itemsLocator));
  const vars = new Map<string, string>();
  const rec = extractRecordsStep([
    { kind: "extract", target: { testId: "commentId" }, as: "commentId", expect: { kind: "visible", target: { testId: "commentId" } } } as any,
    { kind: "extract", target: { testId: "account" }, as: "account", expect: { kind: "visible", target: { testId: "account" } } } as any,
  ]);

  await runStep(actor, rec, vars);

  expect({ commentId: vars.get("records.0.commentId"), account: vars.get("records.0.account") }).toEqual({
    commentId: "c-1001",
    account: "c-1001",
  });
});
