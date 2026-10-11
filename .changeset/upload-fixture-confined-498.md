---
"@jevitate/cli": minor
"jevitate": minor
---

**Security (#498): upload fixtures must stay inside the project root.** A Journey's or mission's upload file must resolve, after following symlinks, to a file inside the folder that holds `.jevitate/`.
- **Refused:** an absolute path outside it, a `../` escape, or a symlink pointing out.
- **Where:** everywhere a Journey or mission runs (`fixture-outside-project`). An upload with no project root is refused too (`fixture-no-root`).
- **Lint and promote:** `journey lint` reports `upload-outside-project`, and promote refuses it. `--accept-weak` does not waive it.
- There is no override; move the fixture into the project.
