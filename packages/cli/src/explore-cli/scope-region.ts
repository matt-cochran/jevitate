import type { TargetDescriptor } from "@jevitate/recording";
import { parseDescriptorSpec } from "../explore-specs.js";
import type { JourneyPrefix } from "../journey-prefix.js";

const REGION_STRATEGIES: ReadonlySet<string> = new Set(["adversarial", "coverage", "exploratory"]);

/**
 * #519: the run's scope region — the Journey anchor's (authoritative) or `--scope-region`'s, never both.
 * Throws a usage message (the caller emits `E_EXPLORE_ARGS`, exit 64, before any browser opens) for
 * `--scope-region` on a strategy without a coverage gate, an unparsable descriptor, or `--scope-region`
 * alongside an anchor that declares its own region.
 */
export function resolveScopeRegions(
  o: { readonly scopeRegion: readonly string[]; readonly strategy?: string; readonly feature?: string; readonly goal?: string },
  prefix?: JourneyPrefix,
): { descriptors: TargetDescriptor[]; spec: string } | undefined {
  const regionStrategy = o.feature === undefined && o.strategy !== undefined && REGION_STRATEGIES.has(o.strategy);
  if (o.scopeRegion.length > 0 && !regionStrategy) throw new Error("--scope-region applies to --strategy adversarial, coverage or exploratory");
  const anchor = prefix?.region;
  if (anchor !== undefined && regionStrategy) {
    if (o.scopeRegion.length > 0) {
      throw new Error(
        `anchor ${prefix?.branch.anchor ?? "(--at-step)"} declares the scope region ${anchor.spec}; --scope-region cannot override it (change it with \`jevitate journey anchor add --region\`, which stales the Journey's approval)`,
      );
    }
    return { descriptors: [anchor.descriptor], spec: anchor.spec };
  }
  if (o.scopeRegion.length === 0) return undefined;
  return { descriptors: o.scopeRegion.map((s) => parseDescriptorSpec(s)), spec: o.scopeRegion.join(" | ") };
}
