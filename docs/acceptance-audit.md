# Acceptance audit contract

`jevitate acceptance audit` is a future read-only local inspection. Its request names a
requirements file and a suite file; its result classifies every required acceptance asset as
`complete`, `missing`, `stale`, or `inconclusive`.

The semantic exit code is `0` only when every asset is complete, `1` for any audit finding,
and `64` for invalid input. The audit and its generated artifacts grant no approval, promotion,
credential, network, or execution authority. Any generated approval script is dry-run by
default and must independently recheck the bound content hashes before an explicit human apply.
