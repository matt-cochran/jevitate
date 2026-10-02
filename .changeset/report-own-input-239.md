---
"@jevitate/cli": patch
"jevitate": patch
---

A report no longer grounds on the run's own unsaved input (#239). A form field holding a value the run itself typed is not evidence of what the app recorded until a click the run made fired writes that all answered 2xx; such a `control-value` quote is rejected ("the run's own typed input in …, never saved"). A goal whose imperative is a write ("record / save / create / add / invite / submit / send / post / publish / register / book / schedule …") is not settled by a find-out `report` before any write of the run succeeded — the report is rejected with that reason, so "record a decision" can no longer end `succeeded` with nothing saved.
