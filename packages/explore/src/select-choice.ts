/** #273: which options a goal-loop `select` may choose (kept off the package's public surface). */

/**
 * #273: a select's placeholder option — punctuation only ("—", "--", "…") or a prompt to choose
 * ("Select…", "-- Choose one --"). Choosing it sets nothing, so it is never offered unless the goal
 * asks to clear the field.
 */
export function isPlaceholderOption(label: string): boolean {
  const t = label.replace(/\s+/g, " ").trim();
  if (/^[\p{P}\p{S}\s]*$/u.test(t)) return true;
  return /^[-–—\s]*(?:please\s+)?(?:select|choose|pick)\b/i.test(t);
}

/** #273: the goal asks to clear / reset a field (then a placeholder option is a legitimate choice). */
export const CLEARS_FIELD = /\b(?:clear|reset|unset|blank|empty|remove the (?:value|selection))\b/i;
