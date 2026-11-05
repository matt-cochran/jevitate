---
"@jevitate/cli": patch
"jevitate": patch
---

`verify-fix --result` no longer writes its own output beside an input inside a git work tree, such as `tests/fixtures/x.json`, where it dirtied the tree. It goes to that repo's `.jevitate/logs/<date>/`. An input already under `.jevitate/logs/`, or outside any repo, keeps its output beside it.
