import { expect, test } from "vitest";
import { extractChangeEvidence, isSkippedChangePath } from "./change-extract.js";

// Realistic `git diff --no-color -M --unified=0 <a>..<b> --` fixtures.

test("renames a data-testid attribute value", () => {
  const diff = [
    "diff --git a/src/Button.tsx b/src/Button.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/Button.tsx",
    "+++ b/src/Button.tsx",
    "@@ -5 +5 @@ export function Button() {",
    '-  <button data-testid="submit-btn">Go</button>',
    '+  <button data-testid="save-btn">Go</button>',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "test-id",
      before: "submit-btn",
      after: "save-btn",
      file: "src/Button.tsx",
      line: 5,
      hunk: "@@ -5 +5 @@ export function Button() {",
    },
  ]);
});

test("renames an aria-label attribute value as a label change", () => {
  const diff = [
    "diff --git a/src/Dialog.tsx b/src/Dialog.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/Dialog.tsx",
    "+++ b/src/Dialog.tsx",
    "@@ -3 +3 @@",
    '-  <button aria-label="Close dialog">x</button>',
    '+  <button aria-label="Dismiss dialog">x</button>',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "label",
      before: "Close dialog",
      after: "Dismiss dialog",
      file: "src/Dialog.tsx",
      line: 3,
      hunk: "@@ -3 +3 @@",
    },
  ]);
});

test("extracts changed JSX text content as a copy change with the new-side line", () => {
  const diff = [
    "diff --git a/src/Button.tsx b/src/Button.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/Button.tsx",
    "+++ b/src/Button.tsx",
    "@@ -5 +5 @@",
    "-      <button>Create New</button>",
    "+      <button>Create</button>",
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "copy",
      before: "Create New",
      after: "Create",
      file: "src/Button.tsx",
      line: 5,
      hunk: "@@ -5 +5 @@",
    },
  ]);
});

test("extracts a changed i18n JSON value as a copy change", () => {
  const diff = [
    "diff --git a/src/locales/en.json b/src/locales/en.json",
    "index 1111111..2222222 100644",
    "--- a/src/locales/en.json",
    "+++ b/src/locales/en.json",
    "@@ -2 +2 @@",
    '-  "greeting": "Hello",',
    '+  "greeting": "Hi",',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "copy",
      before: "Hello",
      after: "Hi",
      file: "src/locales/en.json",
      line: 2,
      hunk: "@@ -2 +2 @@",
    },
  ]);
});

test("extracts a changed route path", () => {
  const diff = [
    "diff --git a/src/App.tsx b/src/App.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/App.tsx",
    "+++ b/src/App.tsx",
    "@@ -1 +1 @@",
    '-<Route path="/old" element={<Home />} />',
    '+<Route path="/new" element={<Home />} />',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "route",
      before: "/old",
      after: "/new",
      file: "src/App.tsx",
      line: 1,
      hunk: "@@ -1 +1 @@",
    },
  ]);
});

test("extracts a route file rename from the diff header", () => {
  const diff = [
    "diff --git a/app/old.tsx b/app/new.tsx",
    "similarity index 100%",
    "rename from app/old.tsx",
    "rename to app/new.tsx",
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "route",
      before: "app/old.tsx",
      after: "app/new.tsx",
      file: "app/new.tsx",
    },
  ]);
});

test("extracts a changed redirect target", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "index 1111111..2222222 100644",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -10 +10 @@",
    '-  redirect("/login")',
    '+  redirect("/signin")',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "redirect",
      before: "/login",
      after: "/signin",
      file: "src/auth.ts",
      line: 10,
      hunk: "@@ -10 +10 @@",
    },
  ]);
});

test("reports an inserted dialog with only an after value", () => {
  const diff = [
    "diff --git a/src/Modal.tsx b/src/Modal.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/Modal.tsx",
    "+++ b/src/Modal.tsx",
    "@@ -0,0 +1 @@",
    '+<dialog role="dialog" open>',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "inserted-ui",
      after: '<dialog role="dialog" open>',
      file: "src/Modal.tsx",
      line: 1,
      hunk: "@@ -0,0 +1 @@",
    },
  ]);
});

test("extracts a quoted before/after pair from a note", () => {
  const note = 'renamed "Old Label" -> "New Label"';

  expect(extractChangeEvidence("", [note])).toEqual([
    { id: "e1", kind: "note", note, before: "Old Label", after: "New Label" },
  ]);
});

test("extracts a renamed X to Y pair from a note", () => {
  const note = "renamed SettingsPage to PreferencesPage";

  expect(extractChangeEvidence("", [note])).toEqual([
    { id: "e1", kind: "note", note, before: "SettingsPage", after: "PreferencesPage" },
  ]);
});

test("keeps a note without a pair as a plain note", () => {
  const note = "tightened the checkout validation";

  expect(extractChangeEvidence("", [note])).toEqual([{ id: "e1", kind: "note", note }]);
});

test("ignores changes to .env files", () => {
  const diff = [
    "diff --git a/.env b/.env",
    "index 1111111..2222222 100644",
    "--- a/.env",
    "+++ b/.env",
    "@@ -1 +1 @@",
    "-API_URL=https://old.test",
    "+API_URL=https://new.test",
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([]);
});

test("ignores changes to lockfiles", () => {
  const diff = [
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "index 1111111..2222222 100644",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "@@ -5 +5 @@",
    "-  version: 1.0.0",
    "+  version: 2.0.0",
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([]);
});

test("ignores identical before/after values", () => {
  const diff = [
    "diff --git a/src/Button.tsx b/src/Button.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/Button.tsx",
    "+++ b/src/Button.tsx",
    "@@ -5 +5 @@",
    '-  <button data-testid="save-btn">Go</button>',
    '+  <button data-testid="save-btn">Go</button>',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([]);
});

test("assigns ids sequentially in extraction order", () => {
  const diff = [
    "diff --git a/src/App.tsx b/src/App.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/App.tsx",
    "+++ b/src/App.tsx",
    "@@ -1 +1 @@",
    '-  <button data-testid="old">A</button>',
    '+  <button data-testid="new">A</button>',
    "@@ -3 +3 @@",
    '-  <button aria-label="Old">B</button>',
    '+  <button aria-label="New">B</button>',
    "@@ -5 +5 @@",
    "-  <button>C New</button>",
    "+  <button>C</button>",
  ].join("\n");

  expect(extractChangeEvidence(diff, []).map((evidence) => evidence.id)).toEqual(["e1", "e2", "e3"]);
});

test("extracts a changed aria-labelledby as an accessible-name change", () => {
  const diff = [
    "diff --git a/src/Field.tsx b/src/Field.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/Field.tsx",
    "+++ b/src/Field.tsx",
    "@@ -4 +4 @@",
    '-  <input aria-labelledby="old-hint" />',
    '+  <input aria-labelledby="new-hint" />',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "accessible-name",
      before: "old-hint",
      after: "new-hint",
      file: "src/Field.tsx",
      line: 4,
      hunk: "@@ -4 +4 @@",
    },
  ]);
});

test("extracts a changed object-literal route path", () => {
  const diff = [
    "diff --git a/src/routes.ts b/src/routes.ts",
    "index 1111111..2222222 100644",
    "--- a/src/routes.ts",
    "+++ b/src/routes.ts",
    "@@ -7 +7 @@",
    '-  { path: "/old", element: <Home /> },',
    '+  { path: "/new", element: <Home /> },',
  ].join("\n");

  expect(extractChangeEvidence(diff, [])).toEqual([
    {
      id: "e1",
      kind: "route",
      before: "/old",
      after: "/new",
      file: "src/routes.ts",
      line: 7,
      hunk: "@@ -7 +7 @@",
    },
  ]);
});

test("skips paths whose segment contains a secret marker", () => {
  expect(isSkippedChangePath("config/secrets/api.ts")).toBe(true);
});
