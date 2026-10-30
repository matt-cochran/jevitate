---
"@jevitate/cli": patch
"jevitate": patch
---

Personas files may declare an optional top-level `context: { organization, role }`; `loadPersonasFile` exposes it as typed `PersonaContext` and refuses unknown keys inside `context`, while personas without it are unchanged (#741).
