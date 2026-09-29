/**
 * Thrown when a policy declares a hard limit that the run cannot enforce (e.g. a site policy's
 * min-interval or budget cap with no repository to track it). Fail closed: an unenforceable hard
 * limit is never silently treated as "no limit".
 */
export class PolicyEnforcementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyEnforcementError";
  }
}
