---
"@jevitate/cli": minor
"jevitate": minor
---

`jevitate login --api <url>` (#449) signs in through an HTTP endpoint instead of a form: it POSTs the credentials as JSON (`--api-user-key`/`--api-password-key`) to an authorized origin, keeps the response's cookies and/or writes a token from the JSON body (`--token-path`, `--storage-key`) into the app origin's localStorage, verifies the session (`--verify-url`, `--auth-check`), and only then saves the storage state (mode 0600). Also `login.api` in personas.json, used for automatic re-login. Redirects to other origins are refused; credentials and the token are never printed or saved anywhere else. `--storage session` is refused (a storage state holds no sessionStorage).
