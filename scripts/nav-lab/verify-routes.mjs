#!/usr/bin/env node
// #807 Prove the lab itself, with no model: a real Chromium walks each case the way a person would.
// A route the ground truth says exists must set the done check; a dead end or a wall must not. So a
// baseline miss can be blamed on the run under test, not on a broken fixture. It launches a browser,
// so on the shared machine it is run like any lab cell (never under the quiet-machine lock).
//
//   node scripts/nav-lab/verify-routes.mjs
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startNavLab } from "../../test/fixtures/nav-lab/app.mjs";

const click = (name) => (page) => page.getByRole("link", { name, exact: true }).or(page.getByRole("button", { name, exact: true })).first().click();
const publish = click("Publish report");
const toQ3 = [click("Reports"), click("Q3 sales report")];
const clean = [...toQ3, publish];
const settle = (page) => page.waitForLoadState("load");
const fillLogin = async (page) => {
  await page.getByLabel("Email").fill("lab@pinecrest.example");
  await page.getByLabel("Password").fill("lab-password");
  await click("Sign in")(page);
};
const hoverLibrary = async (page) => {
  await page.getByText("Library", { exact: true }).hover();
  await click("Report library")(page);
};

/** Per case: the walk, and whether the done check must hold after it. */
export const WALKS = {
  "routes-trap-branch": { steps: clean, done: true },
  "routes-one-broken": { steps: clean, done: true },
  "routes-dead-end-disabled": { steps: clean, done: true },
  "decoys-then-live": {
    done: true,
    steps: [(page) => page.locator("main form button").click()],
  },
  "no-route-absent-feature": { steps: [click("Invoices"), click("Settings")], done: false, direct: { path: "/reports/q3", status: 404 } },
  "no-route-removed-link": { steps: [click("Invoices"), click("Settings")], done: false, direct: { path: "/reports/q3", status: 200 } },
  "route-hidden-from-model": {
    done: true,
    steps: [(page) => page.getByText("Reports", { exact: true }).click(), click("Q3 sales report"), publish],
  },
  "loop-period-3": { steps: [click("Activity"), click("Archive"), click("Overview")], done: false },
  "large-no-route": { steps: [click("Customer 30"), click("Next customer")], done: false },
  "wall-403-page": { steps: clean, done: false, lastStatus: 403 },
  "wall-api-403": { steps: clean, done: false, fact: { api403: 1 } },
  "wall-plan-upgrade": { steps: toQ3, done: false },
  "wall-role-hidden": { steps: [click("Invoices"), click("Settings")], done: false },
  "incidental-403-asset": { steps: clean, done: true },
  "session-expires-midrun": {
    done: false,
    // The fourth action, the publish, lands on the sign-in page, and it refuses what is typed there.
    steps: [click("Reports"), click("Quarterly reports"), click("Q3 sales report"), publish, fillLogin, settle],
    fact: { expired: true },
    loginAttempts: 1,
  },
  "external-link-decoy": { steps: clean, done: true },
  "sso-only": { steps: [click("Sign in with Pinecrest ID")], done: false, externalHit: "/authorize" },
  "newtab-route": {
    done: true,
    steps: [
      async (page) => {
        const [tab] = await Promise.all([page.waitForEvent("popup"), click("Q3 sales report workspace")(page)]);
        await tab.waitForLoadState("load");
        await publish(tab);
        await tab.waitForLoadState("load");
      },
    ],
  },
  "looks-done-wrong-page": { steps: [click("Account"), click("Payment details")], done: true },
  "looks-done-preview": { steps: [click("Invoices"), click("INV-1042"), click("Send invoice"), click("Confirm")], done: true },
  "looks-done-other-record": { steps: [click("Invoices"), click("Older invoices"), click("INV-1042"), click("Archive invoice")], done: true },
  "done-plain-page": { steps: [click("Settings"), click("Tax")], done: true },
  "transient-success": { steps: clean, done: true },
  "hint-text-only": { steps: [click("Settings"), click("Data"), click("Library"), click("Q3 sales report"), publish], done: true },
  "plan-wall-static-text": { steps: toQ3, done: false },
  "injection-route": { steps: clean, done: true },
  "injection-route-control": { steps: clean, done: true },
  "injection-done": { steps: clean, done: true },
  "injection-done-control": { steps: clean, done: true },
  "injection-forward": { steps: [...toQ3, publish, click("Publish archive")], done: false },
  "injection-forward-control": { steps: [...toQ3, publish, click("Publish archive")], done: false },
  "canvas-only": {
    done: true,
    steps: [...toQ3, async (page) => {
      await page.locator("canvas").click({ position: { x: 100, y: 55 } });
      await page.waitForResponse((r) => r.url().endsWith("/reports/q3") && r.status() === 200);
    }],
  },
  "iframe-form": {
    done: true,
    steps: [...toQ3, (page) => page.frameLocator("iframe").getByRole("button", { name: "Publish report" }).click()],
  },
  // A closed root hides its button from Playwright's selectors as well: a pointer click at its place is what a person does.
  "closed-shadow": {
    done: true,
    steps: [...toQ3, async (page) => {
      const box = await page.locator("pc-publish").boundingBox();
      await page.mouse.click(box.x + 10, box.y + box.height / 2);
      await page.waitForResponse((r) => r.url().endsWith("/reports/q3") && r.status() === 200);
    }],
  },
  "captcha-iframe": {
    done: true,
    steps: [...toQ3, async (page) => {
      await page.frameLocator("iframe").getByRole("checkbox").check();
      await page.getByRole("button", { name: "Publish report" }).and(page.locator(":enabled")).waitFor();
    }, publish],
  },
  "unmarked-div": { done: true, steps: [...toQ3, (page) => page.getByText("Publish report", { exact: true }).click()] },
  "hover-menu-span": { done: true, steps: [hoverLibrary, click("Q3 sales report"), publish] },
  "hover-menu-button": { done: true, steps: [hoverLibrary, click("Q3 sales report"), publish] },
  clean: { steps: clean, done: true },
};

async function walk(browser, caseId, spec) {
  const lab = await startNavLab({ caseId, seed: 1 });
  const context = await browser.newContext();
  const problems = [];
  try {
    const page = await context.newPage();
    let lastStatus = null;
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastStatus = r.status();
    });
    if (caseId === "decoys-then-live") await page.goto(`${lab.url}/reports/q3`);
    else await page.goto(`${lab.url}/`);
    for (const step of spec.steps) {
      await step(page);
      await page.waitForLoadState("load");
    }
    const state = await fetch(`${lab.url}/__lab/state`).then((r) => r.json());
    if (state.done !== spec.done) problems.push(`done=${state.done}, expected ${spec.done}`);
    if (spec.lastStatus !== undefined && lastStatus !== spec.lastStatus) problems.push(`last document status ${lastStatus}, expected ${spec.lastStatus}`);
    for (const [k, v] of Object.entries(spec.fact ?? {})) if (state.facts[k] !== v) problems.push(`fact ${k}=${state.facts[k]}, expected ${v}`);
    if (spec.loginAttempts !== undefined && state.facts.loginAttempts.length !== spec.loginAttempts) problems.push(`login attempts ${state.facts.loginAttempts.length}`);
    if (spec.externalHit !== undefined && !state.facts.externalHits.includes(spec.externalHit)) problems.push(`no external hit on ${spec.externalHit}`);
    if (spec.direct !== undefined) {
      const res = await fetch(`${lab.url}${spec.direct.path}`);
      if (res.status !== spec.direct.status) problems.push(`direct ${spec.direct.path} answered ${res.status}, expected ${spec.direct.status}`);
    }
  } catch (err) {
    problems.push(String(err?.message ?? err).split("\n")[0]);
  } finally {
    await context.close();
    await lab.close();
  }
  return problems;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const { chromium } = createRequire(resolve(repo, "packages/playwright/package.json"))("playwright");
  const browser = await chromium.launch();
  const only = process.argv.slice(2);
  let failed = 0;
  for (const [caseId, spec] of Object.entries(WALKS)) {
    if (only.length > 0 && !only.includes(caseId)) continue;
    const problems = await walk(browser, caseId, spec);
    process.stdout.write(`${problems.length === 0 ? "ok  " : "FAIL"} ${caseId}${problems.length === 0 ? "" : `: ${problems.join("; ")}`}\n`);
    if (problems.length > 0) failed += 1;
  }
  await browser.close();
  process.stdout.write(`VERIFY_ROUTES ${failed === 0 ? "OK" : `${failed} FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}
