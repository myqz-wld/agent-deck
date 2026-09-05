---
plan_id: 47
completed_at: 2026-09-04
status: completed
baseline_commit: 072dd7a284eebc2752dab7e5d5505aa2ee480b77
---

# Project code quality scan

## Goal and constraints

Inspect the personal Agent Deck project concurrently for normal-path functional/security defects, concrete architecture costs, obsolete compatibility and dead code. The user explicitly excluded the deep/simple review skills. Four ordinary fresh Codex sessions performed independent primary scans; the lead owned integrated checks and evidence adjudication.

Source and Git index/refs/commits remained unchanged. Workers used only isolated disposable evidence. No live provider, credential/database/transcript access, application lifecycle action, dependency/native binding change, deployment or fix was authorized or performed. Final records and evidence were archived under `ref/` using repository-relative paths.

## Completed tasks

| Track | Scope | Completion evidence |
| --- | --- | --- |
| Runtime | `src/main/adapters/`; 601 tracked files | 95 primary files directly inspected; 3 MEDIUM defects and 1 LOW architecture opportunity accepted; 41 existing tests and 3 probes passed. |
| Coordination | Session/store/MCP/teams/Hook/core/shared contracts; 630 files | 114 primary files directly inspected; 1 HIGH, 2 MEDIUM and 1 LOW dead-code family accepted; 118 existing tests and 7 probes passed. |
| Desktop | Renderer/preload/IPC/Browser/settings/bootstrap/electron host; 689 files | 108 primary files directly inspected; 1 conditional Windows HIGH, 4 MEDIUM and 1 linked LOW opportunity accepted; 37 existing tests and 6 probes passed, with one synthetic race excluded. |
| Remote | Remaining hosts, clients, gateways, protocol and Remote services; 726 files | 108 primary files directly inspected; 1 HIGH and 2 MEDIUM accepted; 41 existing tests and 3 probes passed. |
| Lead | Build/resources/deployment entrypoints, whole import graph and finding verification | Typecheck, architecture and deployment static checks passed; 29 deployment and 4 installer tests passed; all 19 worker probes rerun plus an independent production Hook probe. |

The inventories cover all 2,646 tracked source/test files. Direct body/excerpt inspection covers 425 primary files and additional context. This is bounded scan coverage; the final review is explicitly expired for exemption purposes so future reviews cannot treat it as whole-file clearance.

## Decisions and integration

- Ordinary read-only session dispatch replaced the initially considered review-skill workflow after the user's correction. No reviewer Agent selector or paired workflow was used.
- Same-day REVIEW_267 was read to avoid re-reporting deleted compatibility and to preserve current identity/recovery/Browser contracts.
- Every accepted functional finding received bounded lead source checks and an isolated reproduction rerun. Windows command construction was checked against Microsoft PowerShell quoting semantics; native Windows behavior remains untested.
- Remote Claude approval was counted once across adapter/Core ownership. Diff architecture work is linked to two defects rather than counted as another user failure.
- Missing MCP authentication grants external metadata reads after the URL bypass, while all 16 external-disallowed guards remain effective. CLI history/state poisoning was demonstrated only for unclaimed CLI identities in memory.
- Dead code is confined to retired handoff task-policy methods/branches and their wiring/tests. The live containing module, preserve-team transfer, dependency cleanup and current Browser/recovery paths remain required.
- All four required reports were consumed and their sessions closed after acceptance. Session ids, anchors and task ids are archived with the evidence.

## Validation and handoff

[REVIEW_268](../../reviews/recent-3-days/REVIEW_268_project-code-quality-scan.md) contains the complete findings, locations, practical consequences, repair directions and validation limits. Its [evidence directory](../../reviews/recent-3-days/project-code-quality-scan-evidence/README.md) preserves reports, exact coverage, probes, outputs and provenance.

Final result: **3 HIGH, 11 MEDIUM, 4 LOW accepted items**. The implementation is unchanged and these findings remain open. No full-suite run, package build, live provider/Browser operation, restart or deployment was performed. The final SQLite probe left the native binding hash unchanged.

All existing typed plan/review records were checked against 2026-09-04 bucket boundaries. REVIEW_215 moved from history to the inclusive 30-day bucket; new records and affected indexes were updated. Root routing policy did not change. The active plan copy and this invocation's scratch workspace are removed after final artifact checks; archived evidence is retained.

The scan objective and evidence handoff are complete. Source fixes, a task-dependency schema migration, exact Browser foreground behavior and larger queue/Diff refactors remain separate implementation scope.
