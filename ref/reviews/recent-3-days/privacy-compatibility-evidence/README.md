# Codex protocol evidence

These two schemas were generated from the installed Codex 0.154.0 app-server during this audit.
The JSON-RPC error payload is an object with required code and message fields. This evidence supports
removing the old string-error alternative; terminal notification error shapes are unchanged.

Command: `codex app-server generate-json-schema --out <temporary-schema-directory>`.

Related record: `ref/reviews/recent-3-days/REVIEW_274_privacy-and-compatibility-cleanup.md`.
