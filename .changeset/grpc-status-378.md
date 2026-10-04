---
"@jevitate/cli": patch
"jevitate": patch
---

gRPC-web and Connect calls are now judged on the RPC's own result, not just the HTTP 200 they always answer with: jevitate reads `grpc-status` from the response header or the body's trailer frame (and a Connect stream's end-of-stream frame). A failed RPC maps to its standard HTTP equivalent, so `responseStatus:POST /pkg.Svc/Method=2xx` no longer holds for grpc-status 13, its detail reads `200 (grpc-status 13 internal)`, and a server-side failure (INTERNAL, UNAVAILABLE, UNKNOWN, …) is reported as an HTTP 5xx defect. A rejected RPC write is no longer counted as a landed side effect, so the repeated-write guard allows a retry. Only the status code is kept; the body and `grpc-message` are never logged or stored.
