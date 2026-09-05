# Remediation evidence

Companion evidence for REVIEW_269 and PLAN_48, implementing the accepted REVIEW_268 findings.

- `source-manifest.json` and `changed-source.txt`: exact final source/test paths, line counts and SHA-256 hashes. These include worker changes, test splits and lead integration corrections.
- `entry-graph.json` / `entry-graph.cjs`: source-entrypoint reachability, including untracked newly created modules. Run the script from the repository root; generated graph/edges go to disposable `.ref/reviews/` output. Type edges and literal dynamic imports are included; runtime registration still needs source inspection.
- `runtime/report.md`, `remote/report.md`, `desktop/report.md`: accepted worker implementation handoffs, focused commands, permanent regressions and platform limits. Their scoped logs and manifests accompany them; worker counts overlap global coverage.
- `lead/`: security, Git identity, task deletion/handoff, integration and final project validation. Initial fixture failures are preserved separately from corrected results. The first full run's very large byte-array diff is summarized in `integration-initial-results.txt`.
- `validation.json`: authoritative integrated results and native-binding fingerprint for this delivery.

All source paths are repository-relative. Logs are sanitized to remove machine-specific home/repository prefixes. No live credentials, user databases or provider transcripts are included.

The permanent regressions live beside production source. Re-run `pnpm typecheck`, `pnpm run test --maxWorkers=1 --minWorkers=1`, and `pnpm build` from the repository root. Worker scripts/configs are supplemental scoped checks; they do not replace the integrated commands. Runtime replay scripts create only disposable `.ref/` evidence, not new archived results.
