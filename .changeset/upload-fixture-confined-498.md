---
"@jevitate/cli": minor
"jevitate": minor
---

**Security (#498): upload fixtures must stay inside the project root.** A Journey's or mission's upload file must resolve, after following symlinks, to a file inside the folder that holds `.jevitate/`.
- **Refused:** an absolute path outside it, a `../` escape, or a symlink pointing out.
- **Where:** everywhere a Journey or mission runs (`fixture-outside-project`).
- **The project root** is only a folder holding `.jevitate/`: never the working directory, the git root, your home folder or `/`. With none, an upload is refused (`fixture-no-root`).
- **Sensitive files inside the project are refused too** (`fixture-sensitive`): any dot-file or dot-folder (`.env`, `.git`, `.jevitate`), keys and certificates (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`…), HAR files and traces, and storage-state files.
- **Lint and promote:** `journey lint` reports `upload-outside-project` and `upload-sensitive-file`, and promote refuses both. `--accept-weak` does not waive it.
- There is no override; move the fixture into the project.
