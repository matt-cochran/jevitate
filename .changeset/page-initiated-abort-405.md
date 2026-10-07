---
"@jevitate/cli": patch
"jevitate": patch
---

Adversarial runs no longer report `failed-request` for a request the page itself cancelled with no response (#405). A superseded type-ahead or search read — including a read RPC sent as POST — and a document navigation replaced by another navigation are benign client-side aborts. An aborted write, and every genuine network failure (DNS, connection, SSL, timeout), still produces the signal.
