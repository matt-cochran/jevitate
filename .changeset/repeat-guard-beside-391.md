---
"@jevitate/cli": patch
"jevitate": patch
---

Goal runs no longer refuse "I've changed my nameservers" after "Review instructions" was clicked beside it (#391). When another control in the same part of the page (its section, form, dialog or card) has been used since a button's write, that button may be clicked once more even if its own part of the page looks unchanged, because client state may now make it send another request (`RetryShareDomain` instead of `RefreshShareDomain`). The next click is judged by the request it actually sends: the same click again with nothing used in between is still refused, as is a re-click after using a control elsewhere on the page (a menu), a paid or destructive control, and a write whose outcome is unknown.
