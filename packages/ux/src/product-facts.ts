// product-facts.ts — the product's own ground truth for the UX review (#198).
//
// `.jevitate/product.json` (or `--product <file>`) states what the product IS: its plans and
// prices, its key journeys, and the intended primary next step on a page. The review compares what
// a screen shows against it in CODE — a wrong price is a fact conflict found by matching text, not
// by asking a model — and uses the intended next step to check whether a page makes the intended
// path available (suggest the next step without hiding the other options).
//
// The file is validated strictly: every problem is reported with its JSON path in ONE typed
// refusal (`ProductFactsError`, code `E_UX_PRODUCT_INPUT` — a usage error), never silently ignored.
import { z } from "zod";
import { urlTemplate } from "@jevitate/recording";
import { normalizeText } from "./adjudicate.js";

export const PRODUCT_FACTS_VERSION = 1 as const;

const Name = z.string().trim().min(1).max(120);
const Interval = z.enum(["month", "year", "week", "day", "once"]);

const PriceSchema = z
  .object({
    /** The amount in the currency's major unit (149 = $149.00). */
    amount: z.number().finite().nonnegative(),
    interval: Interval,
    /** ISO 4217 code; defaults to the file's `currency`. */
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .strict();

const PlanSchema = z
  .object({
    name: Name,
    /** Other names the plan is shown under ("Professional" for "Pro"). */
    aliases: z.array(Name).max(10).optional(),
    prices: z.array(PriceSchema).min(1).max(10),
    /** Length of the plan's free trial, when it has one. */
    trialDays: z.number().int().positive().max(3650).optional(),
  })
  .strict();

const Route = z
  .string()
  .regex(/^\/[^\s?#]*$/, "a route is a URL path starting with '/' (no query or hash); `:param` and `*` match one segment");

const JourneySchema = z
  .object({
    name: Name,
    /** The routes the journey passes through, in order. */
    routes: z.array(Route).min(1).max(50),
  })
  .strict();

const PageSchema = z
  .object({
    route: Route,
    /** The visible name of the control that is this page's intended primary next step. */
    nextStep: Name,
    /** Other options the page should keep available (documentation; never flagged for existing). */
    alternatives: z.array(Name).max(20).optional(),
  })
  .strict();

export const ProductFactsSchema = z
  .object({
    version: z.literal(PRODUCT_FACTS_VERSION),
    product: Name.optional(),
    /** Default currency of every price (ISO 4217). */
    currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
    plans: z.array(PlanSchema).max(50).default([]),
    journeys: z.array(JourneySchema).max(50).default([]),
    pages: z.array(PageSchema).max(200).default([]),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Map<string, number>();
    f.plans.forEach((p, i) => {
      for (const n of [p.name, ...(p.aliases ?? [])]) {
        const k = normalizeText(n);
        const prior = seen.get(k);
        if (prior !== undefined) ctx.addIssue({ code: "custom", path: ["plans", i, "name"], message: `plan name/alias "${n}" is already used by plans[${prior}]` });
        else seen.set(k, i);
      }
    });
    const routes = new Map<string, number>();
    f.pages.forEach((p, i) => {
      const prior = routes.get(p.route);
      if (prior !== undefined) ctx.addIssue({ code: "custom", path: ["pages", i, "route"], message: `route "${p.route}" is already described by pages[${prior}]` });
      else routes.set(p.route, i);
    });
  });

export type ProductFacts = z.infer<typeof ProductFactsSchema>;
export type ProductPlan = ProductFacts["plans"][number];
export type ProductPage = ProductFacts["pages"][number];

/** An invalid product facts file — every problem with its JSON path. A usage error (exit 64). */
export class ProductFactsError extends Error {
  readonly code = "E_UX_PRODUCT_INPUT" as const;
  constructor(
    readonly source: string,
    readonly issues: readonly string[],
  ) {
    super(`invalid product facts ${source}: ${issues.join("; ")}`);
    this.name = "ProductFactsError";
  }
}

/** Validates parsed JSON as product facts. Throws `ProductFactsError` naming every problem. */
export function parseProductFacts(raw: unknown, source = "product facts"): ProductFacts {
  const r = ProductFactsSchema.safeParse(raw);
  if (r.success) return r.data;
  throw new ProductFactsError(
    source,
    r.error.issues.map((i) => `${i.path.length > 0 ? i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") : "(root)"}: ${i.message}`),
  );
}

/** Parses a product facts file's text (JSON). Throws `ProductFactsError` on bad JSON too. */
export function parseProductFactsText(text: string, source: string): ProductFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProductFactsError(source, [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return parseProductFacts(raw, source);
}

// ---------- matching ----------

function segments(route: string): string[] {
  return route.split("/").filter((s) => s.length > 0);
}

/** Does a normalized route (`routeOf(url)`) match a facts route (`:param`/`*` match one segment)? */
export function routeMatches(factsRoute: string, route: string): boolean {
  const want = segments(urlTemplate(factsRoute));
  const got = segments(route);
  if (want.length !== got.length) return false;
  return want.every((w, i) => w === "*" || w.startsWith(":") || w === got[i]);
}

/** The facts page entry for a route (exact routes win over patterns). */
export function factsPageFor(facts: ProductFacts | undefined, route: string): ProductPage | undefined {
  if (facts === undefined) return undefined;
  return facts.pages.find((p) => urlTemplate(p.route) === route) ?? facts.pages.find((p) => routeMatches(p.route, route));
}

/** The journeys passing through a route (the "feature" a finding there belongs to). */
export function journeysFor(facts: ProductFacts | undefined, route: string): string[] {
  if (facts === undefined) return [];
  return facts.journeys.filter((j) => j.routes.some((r) => routeMatches(r, route))).map((j) => j.name);
}

/** Does a control's visible name name the intended next step? (normalized; either contains the other) */
export function namesStep(controlName: string, step: string): boolean {
  const a = normalizeText(controlName);
  const b = normalizeText(step);
  return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || (b.includes(a) && a.length >= 4));
}

// ---------- fact conflicts (code only) ----------

export interface FactConflict {
  /** `price` (a plan shown at a price the facts do not list) or `trial` (a trial length). */
  readonly kind: "price" | "trial";
  readonly plan?: string;
  /** The verbatim on-screen excerpt (one line). */
  readonly quote: string;
  /** What the screen says, e.g. "$129/month". */
  readonly found: string;
  /** What the facts say, e.g. "$149/month". */
  readonly expected: string;
}

const SYMBOL_TO_CODE: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };
const CODE_TO_SYMBOL: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };
/** A money amount: a symbol or code, then digits (thousands separators, cents). */
const MONEY = /(?:([$€£¥])\s?|\b(USD|EUR|GBP|JPY)\s?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
/** Words right before an amount that make it not a price (a saving, a former price, a credit). */
const NOT_A_PRICE = /\b(?:save|saving|savings|off|was|discount|credit|refund|reduced from|normally)\W*$/i;
const INTERVAL_AFTER: ReadonlyArray<[RegExp, ProductPlan["prices"][number]["interval"]]> = [
  [/^\s*(?:\/|per|a|an|each)\s*(?:mo\b|mon\b|month)/i, "month"],
  [/^\s*(?:\/|per|a|an|each)\s*(?:yr\b|year|annum)|^\s*(?:billed\s+)?(?:annually|yearly)/i, "year"],
  [/^\s*(?:\/|per|a|an|each)\s*(?:wk\b|week)|^\s*weekly/i, "week"],
  [/^\s*(?:\/|per|a|an|each)\s*day|^\s*daily/i, "day"],
  [/^\s*(?:\/\s*)?(?:monthly)\b/i, "month"],
];

function fmt(amount: number, currency: string, interval: string): string {
  const sym = CODE_TO_SYMBOL[currency];
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const money = sym === undefined ? `${currency} ${n}` : `${sym}${n}`;
  return interval === "once" ? money : `${money}/${interval}`;
}

function nameRegex(n: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * Prices and trial lengths on a screen that contradict the product facts. Code only: a price is
 * attributed to a plan only when the plan's name (or alias) is on the SAME line before it and no
 * other plan name sits between them; amounts introduced as a saving/former price are not prices;
 * an amount matching ANY of the plan's listed prices (in its currency) is consistent. Each line is
 * judged on its own, so a pricing table that puts every plan on one line attributes each amount to
 * the nearest plan name before it.
 */
export function findFactConflicts(visibleText: string, facts: ProductFacts | undefined): FactConflict[] {
  if (facts === undefined) return [];
  const out: FactConflict[] = [];
  const seen = new Set<string>();
  const names = facts.plans.flatMap((p) => [p.name, ...(p.aliases ?? [])].map((n) => ({ plan: p, re: nameRegex(n) })));
  const lines = visibleText.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 0);
  // A plan name on a line of its own (a pricing card's heading) applies to the next line too.
  let carried: { plan: ProductPlan; ttl: number } | undefined;
  for (const line of lines.map((l) => l.slice(0, 500))) {
    // Where each plan name occurs on the line.
    const marks: { at: number; plan: ProductPlan }[] = [];
    for (const { plan, re } of names) {
      const g = new RegExp(re.source, "giu");
      for (const m of line.matchAll(g)) marks.push({ at: m.index ?? 0, plan });
    }
    marks.sort((a, b) => a.at - b.at);
    let lineHadMoney = false;
    for (const m of line.matchAll(MONEY)) {
      lineHadMoney = true;
      const at = m.index ?? 0;
      const before = line.slice(0, at);
      if (NOT_A_PRICE.test(before.slice(-24))) continue;
      const owner = [...marks].reverse().find((k) => k.at < at)?.plan ?? (marks.length === 0 ? carried?.plan : undefined);
      if (owner === undefined) continue;
      const currency = m[1] !== undefined ? (SYMBOL_TO_CODE[m[1]] ?? facts.currency) : (m[2] ?? facts.currency);
      const amount = Number(`${(m[3] ?? "0").replace(/,/g, "")}.${m[4] ?? "0"}`);
      const after = line.slice(at + m[0].length, at + m[0].length + 24);
      const interval = INTERVAL_AFTER.find(([re]) => re.test(after))?.[1];
      const listed = owner.prices.map((p) => ({ ...p, currency: p.currency ?? facts.currency }));
      const sameCurrency = listed.filter((p) => p.currency === currency);
      if (sameCurrency.length === 0) continue; // a currency the facts do not price in: not comparable
      if (sameCurrency.some((p) => Math.abs(p.amount - amount) < 0.005)) continue;
      const comparable = interval === undefined ? sameCurrency : sameCurrency.filter((p) => p.interval === interval);
      if (comparable.length === 0) continue; // an interval the facts do not price: not comparable
      const found = fmt(amount, currency, interval ?? comparable[0]!.interval);
      const expected = comparable.map((p) => fmt(p.amount, p.currency, p.interval)).join(" or ");
      const key = `price|${owner.name}|${found}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "price", plan: owner.name, quote: line.slice(0, 200), found, expected });
    }
    // Trial length: "14-day free trial", "trial lasts 7 days", "7 day trial".
    const trials = facts.plans.filter((p) => p.trialDays !== undefined);
    if (trials.length > 0) {
      const t = /(\d{1,4})[\s-]*days?\b[^.\n]{0,20}\btrial\b|\btrial\b[^.\n]{0,30}?\b(\d{1,4})[\s-]*days?\b/i.exec(line);
      if (t !== null) {
        const days = Number(t[1] ?? t[2]);
        const owner = [...marks].reverse().find((k) => k.at < (t.index ?? 0))?.plan;
        const candidates = owner?.trialDays !== undefined ? [owner] : trials;
        if (!candidates.some((p) => p.trialDays === days)) {
          const expected = [...new Set(candidates.map((p) => `${p.trialDays}-day trial`))].join(" or ");
          const key = `trial|${owner?.name ?? ""}|${days}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ kind: "trial", ...(owner === undefined ? {} : { plan: owner.name }), quote: line.slice(0, 200), found: `${days}-day trial`, expected });
          }
        }
      }
    }
    // A heading-only plan line carries over the next few lines (a card's tagline, then its price);
    // any line with an amount ends the carry.
    if (marks.length > 0) carried = lineHadMoney ? undefined : { plan: marks[marks.length - 1]!.plan, ttl: 3 };
    else if (lineHadMoney || carried === undefined || carried.ttl <= 1) carried = undefined;
    else carried = { plan: carried.plan, ttl: carried.ttl - 1 };
  }
  return out;
}
