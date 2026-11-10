import { MAX_GLOB_ALTERNATIVES as SHARED_MAX, expandBraces as sharedExpandBraces, isInScope as sharedIsInScope, matchGlob as sharedMatchGlob, type CapabilityScope as SharedCapabilityScope } from "@jevitate/domain";

/** Preserve this package's public declarations while sharing the oracle implementation. */
export interface CapabilityScope extends SharedCapabilityScope {}
export const MAX_GLOB_ALTERNATIVES = SHARED_MAX;
export function expandBraces(pattern: string): string[] {
  return sharedExpandBraces(pattern);
}
export function matchGlob(pattern: string, pathname: string): boolean {
  return sharedMatchGlob(pattern, pathname);
}
export function isInScope(url: string, scope: CapabilityScope): boolean {
  return sharedIsInScope(url, scope);
}
