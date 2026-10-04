---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs no longer refuse a re-click whose only request was bookkeeping: a first-party analytics event (`RecordShowcaseEvent`, a POST under `/analytics/`, a beacon), a heartbeat, or an idempotent read marker (`MarkConversationRead`, `…/read`) is not a side effect, so a "Chat with us" link or a conversation row can be opened again (#374). A button whose write finished may also be clicked again once the screen has moved on since, so "I've changed my nameservers" can send `RetryShareDomain` after its earlier `RefreshShareDomain` (#380). The same control on an unchanged screen, and any paid or destructive control, is still refused as a repeat.
