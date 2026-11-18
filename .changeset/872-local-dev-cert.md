---
"@jevitate/cli": minor
"jevitate": minor
---

Accept a local dev server's self-signed certificate (#872).
- **`--accept-local-dev-cert <origin>`:** a new repeatable flag on every command that opens a browser. Name an `https` origin on `localhost`, `127.0.0.0/8` or `[::1]`, and jevitate pins the public key that server presents at launch, so only its certificate is accepted. Every other host is validated as usual. A non-loopback or plain-`http` origin is a usage error (exit 64) before a browser starts.
- **Warning:** passing `--browser-arg --ignore-certificate-errors` now warns that it turns certificate checks off for every host, and points to the scoped flag.
