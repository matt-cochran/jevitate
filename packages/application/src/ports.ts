import type { SitePolicy } from "@jevitate/domain";

export interface Clock {
  nowIso(): string;
  monotonicMs(): number;
}

export interface SitePolicyRepository {
  get(site: string, account: string): Promise<SitePolicy | null>;
  set(site: string, account: string, policy: SitePolicy): Promise<void>;
}

export interface BudgetLimits {
  hourlyLimit?: number;
  dailyLimit?: number;
}

export interface BudgetRepository {
  reserve(site: string, account: string, cls: string, limits: BudgetLimits, nowIso: string): Promise<{ allowed: boolean }>;
}

export interface ActivityRepository {
  lastAt(site: string, account: string, cls: string): Promise<string | null>;
  stamp(site: string, account: string, cls: string, nowIso: string): Promise<void>;
  /**
   * #854: atomically records `nowIso` as the latest activity, but only when there is none yet or the
   * recorded one is at or before `notBeforeIso` (null: always). True when this call claimed it. Two
   * runs that both read an old `lastAt` cannot both pass a min interval: only one claim succeeds.
   */
  claim(site: string, account: string, cls: string, nowIso: string, notBeforeIso: string | null): Promise<boolean>;
}
