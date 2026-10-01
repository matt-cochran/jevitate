---
"@jevitate/cli": patch
"jevitate": patch
---

A long-pending in-flight request is no longer forgotten (#283). `requestMade` matches a request once it is sent, whether or not its response has arrived (a gRPC-web/Connect unary call the server holds open while a job runs); `responseStatus` judges only answered requests. A write one of the run's clicks fired stays tracked until it ends, even after the settle rule treats it as a long-poll: a `wait` observes it within the job-wait budget ("POST /… (sent by an earlier click) is still in flight") instead of reporting "nothing is pending", and a model `blocked` is deferred the same way. It also stays in `sideEffects` and in the repeated-side-effect guard.
