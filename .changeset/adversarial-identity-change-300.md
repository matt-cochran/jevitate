---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial runs notice when an action switches the signed-in identity (#300), such as a "Continue as demo" shortcut on a login page. The run takes a baseline from the session's auth cookies and auth-named storage, kept as hashes only and never raw values; a JWT is compared by its subject claims. After each settled action it checks again. On a switch, that step's invariants (`userInvariant` and the declared spec) are not judged, its pending `before` snapshot and queued `never.response` hits are dropped, and the control is never picked again. The run then goes back to the start URL in a fresh session from the original storage state. Every switch is listed in `identityChanges` (`{step, action, url, route, reason, restored}`). When the original identity can't be restored, the run stops `inconclusive` with `stop: "identity-changed"` and `failure.kind: "identity-changed"`.
