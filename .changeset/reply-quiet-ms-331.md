---
"@jevitate/cli": minor
"jevitate": minor
---

New `--reply-quiet-ms <ms>` sets how long a chat reply must hold still before it is read as complete (#331). It applies to the goal and usability strategies, suite items (`replyQuietMs`) and MCP `run_exploration`, and the default stays 1000. For an assistant that answers in several parts (a sentence, then a slot card that a poll brings a moment later), raise it so the model reads the whole reply instead of answering the first part.
