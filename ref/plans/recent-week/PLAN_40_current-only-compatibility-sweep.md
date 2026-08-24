---
plan_id: 40
completed_at: 2026-08-17
status: completed
---

# PLAN_40_current-only-compatibility-sweep: Remove unsupported compatibility code

## Goal

Treat Agent Deck as a current-version-only project and remove code, tests, aliases, migrations,
facades, and fallback branches that exist solely for superseded pre-release formats. Preserve
current provider variation, security checks, lifecycle recovery, corruption handling, concurrency
fencing, and exact rejection of non-current protocol or persistence versions.

## Context and constraints

- Dispatch baseline: `76e2b6471db034367d9d1686659c2545fbb0871f` with a clean worktree.
- Prior policy: `REVIEW_204_compatibility-cleanup.md` established that Agent Deck has no supported
  upgrade contract and rejects non-current persisted formats without mutation.
- Six independent Agent Deck sessions shared one worktree with disjoint hard write boundaries.
- Root docs, `ref/**`, and bundled prompt assets were read-only during worker execution. No prompt
  semantic change was required.
- The lead owned cross-boundary integration, strict current-producer adjudication, full validation,
  final records, and time-bucket maintenance.

## Dispatch controls

Every worker was approved with `codex-cli`, `gpt-5.6-sol`, `xhigh`, fresh context,
`workspace-write`, approval policy `never`, and shared team `compat-cleanup-20260817`. The
dispatcher success metadata confirmed adapter, repository cwd, and team id
`e8c6353b-1046-4755-979f-0987d2282e1c`; its success schema did not echo model, thinking, fresh
context, sandbox, or approval policy, so those observed runtime fields remain unknown. No
substitution or fallback was used.

| Track | Session | Write boundary | Final result |
|---|---|---|---|
| A · Provider adapters | `01a0131b-0dc5-7e51-afb2-b182f1df4425` | `src/main/adapters/**` | 18 files; removed unproduced Grok/provider aliases; 1,323 adapter tests passed |
| B · Session/MCP/Browser | `01a0131b-b108-7683-9476-1113e0aa0daa` | approved session, MCP, hook, config, and permission directories | 59 files; removed continuation v1, text-success aliases, dead facades, and adopt history |
| C · Persistence/Desktop | `01a0131b-b1ea-7273-9a82-109488876f63` | approved store, remote-host, IPC, preload, shared, and app paths | 9 files; removed remote profile v3 migration, refresh state, orphan DTO, and adopt header |
| D · Remote Core | `01a0131b-b2ce-7d23-8c52-bb35f282e75c` | hosts, clients, protocol, contracts, core, composition, gateways | 49 files; removed seven methods, six capabilities, loose 2.7 fields, and Core MCP text success |
| E · Renderer | `01a0131b-b3ac-7d60-9c01-b89fd58262ea` | `src/renderer/**` | 37 files; removed stale payload/UI branches, optional facades, fixtures, and adopt parsing |
| F · Tooling/Deployment | `01a0131b-b48d-76c1-8a63-6134d46e2ab4` | scripts, deploy, bundled wrappers/native helpers | 6 tracked + 2 new test files; exact current deployment and artifact contracts |

## Integration decisions

1. A keyword alone was never removal evidence. A branch was deleted only after tracing current
   pinned providers, producers, consumers, persisted schemas, or operational recovery contracts.
2. Cross-boundary orphans were returned to the already-approved owner rather than edited by the
   reporting worker. This closed the Grok oneshot, reasoning field, remote profile DTO, removed
   capability fixture, Server Core MCP, and adopt-header pairs without write overlap.
3. Browser MCP text/image content, explicit MCP text errors, Codex quota variants, provider
   recovery, session identity rename fencing, history token reconciliation, protocol-version
   rejection, deployment resume/rollback, and the Browser/node_repl process shim remain current.
4. The final implementation scope is 180 files: 1,581 insertions and 1,793 deletions, net 212 lines
   removed, including two new contract tests and three deleted compatibility-only files.

## Validation

- `pnpm typecheck` passed both architecture guards and Node/Web TypeScript.
- `pnpm test` passed 971 files and 6,134 tests; 2 files and 3 explicit live/platform tests skipped.
- `pnpm build` passed all main, preload, renderer, and build-info stages.
- `pnpm check:deployment` and `pnpm logger:check` passed.
- `bash scripts/file-level-review-expiry.sh` completed; all active functional areas were included in
  the six-session scan rather than relying on old exemptions.
- `git diff --check` and the approved-path audit passed.
- Every changed non-test source file is at most 500 lines.

## Final status and handoff

Completed. The definitive evidence and residual validation boundary are in
`REVIEW_252_current-only-compatibility-sweep.md`. Main-process changes intentionally take effect on
the next normal Agent Deck launch because restarting the live app would terminate this delivery
session. The Docker-backed Feishu runtime build was not repeated; its changed validators have
direct tests and the deployment/static checks passed.
