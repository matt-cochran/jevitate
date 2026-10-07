---
"@jevitate/cli": patch
"jevitate": patch
---

Usability runs no longer report "an error interrupted the task" for reads the browser cancelled (`net::ERR_ABORTED`) because the run's own click navigated away, or for a gRPC-web/Connect request that answered and was then aborted (#393). Requests that answered 4xx/5xx, or failed without a navigation, are still reported.
