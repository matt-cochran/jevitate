---
"@jevitate/cli": patch
"jevitate": patch
---

Controls that reset or switch off a credential or security factor are now classified destructive (#333): "Reset authenticator", "Disable two-factor", "Turn off 2FA", "Reset password", "Unlink security key", "End all sessions" and similar. Without `--allow-destructive` (or a goal that asks for that action) they are refused like "Delete" and "Revoke", so a goal run no longer resets the test identity's MFA factor. A bare "Reset" or "Reset filters" is unaffected.
