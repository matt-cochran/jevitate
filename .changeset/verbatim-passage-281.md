---
"@jevitate/cli": patch
"jevitate": patch
---

Quoted goal text is typed verbatim (#281). A passage the goal quotes in double quotes as the text to type — right after a typing verb ("type", "enter", "paste", "write", "import", "insert", "post", "reply", "add", "use", "with") or a `text:` / `content:` / `body:` / `message:` lead-in, spanning several lines or 6+ words — is typed by code into a textarea / rich-text field without asking the model, its line breaks kept and never cut by the free-text cap (that cap is for generated essays). A goal can carry a file's text this way (`--goal "Import this text: \"$(cat note.txt)\""`). Before, the model paraphrased it ("Click here to learn more…" became "Discover more…") and the paragraphs were collapsed.
