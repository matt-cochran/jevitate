---
"@jevitate/cli": minor
---

Site policies are safe for parallel runs (#854).
- **Atomic min interval:** the min interval is now claimed atomically, so two runs that start together cannot both pass it. The second waits out a short shortfall or is refused with `min_interval`.
- **`siteThrottles`:** a new optional policy field with the same shape as `throttles`. It caps a site across all its accounts, so runs split across accounts never get each account's full budget. Its activity and budget are kept under the reserved account `*`, and `site policy set --account '*'` is refused.
