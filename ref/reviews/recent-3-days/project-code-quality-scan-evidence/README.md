# Project scan evidence

This directory supports [REVIEW_268](../REVIEW_268_project-code-quality-scan.md), against source baseline `072dd7a284eebc2752dab7e5d5505aa2ee480b77`.

- `runtime/`, `coordination/`, `desktop/`, `remote/`: original bounded worker reports, exact directly inspected file lists, disposable reproduction sources/configuration, and selected validation output.
- `lead/`: independent reproduction reruns, an additional real Hook-route probe, integrated static checks, native installer test evidence and earlier bounded adjudication notes. Earlier notes describe their point-in-time state; the final review and accepted ledger govern the completed result.
- `accepted-findings.md`: final lead finding classifications and counter-evidence.
- `scope-manifest.json`, `scopes/`: exact primary inventories; inventory does not imply every file was read in full.
- `entry-graph.json`: production-root reachability result and computed-import limits.
- `entry-graph.cjs`: the lead's disposable static graph program. Its output workspace remains the original ignored scan workspace.
- `provenance.json`: worker ids, anchors, task ids, closed lifecycle, accepted counts and validation restrictions.

The tests assert current faulty outcomes. Passing reproduction tests demonstrate the defect; they do not demonstrate a fix. The desktop synthetic initial-load race is supplementary and excluded from accepted findings. The Windows test intercepts generated command text and never launches PowerShell.

## Replaying evidence

Reproductions preserve the original isolated temporary layout. From the source baseline, restore a desired track's files to `/tmp/agent-deck-scan/2026-09-04-project-scan/<track>/` and run the commands recorded in that track's report from the repository root. Inspect any existing temporary directory before replacing files. The coordination commands additionally require their `runtime-tmp/` directory. The submodule probe creates disposable Git repositories there; it does not switch the Agent Deck session worktree. Desktop helpers `browser-fakes.ts` and `source-selection-callback.ts` must stay beside their tests.

Use `pnpm run test` to forward Vitest options through the existing Electron-compatible wrapper. Do not rebuild SQLite bindings or invoke application install/restart/deployment commands. The four installer tests use the separate native command `node --test scripts/install-local-macos.test.mjs`.

Repository/home prefixes have been removed from captured outputs. Fixture paths such as `/workspace`, `/fixture` and Windows sample filenames are synthetic test input. Original temporary-path references describe the evidence layout and contain no user identity or live credentials.
