# Accepted findings ledger

Baseline: `072dd7a284eebc2752dab7e5d5505aa2ee480b77`. No source fixes applied. Each item below has bounded lead verification; worker reports retain precise scope and limits.

| ID | Severity | Lead classification and evidence | Primary path |
| --- | --- | --- | --- |
| coordination-01 | HIGH | Raw-URL authentication bypass; independently reproduced unauthenticated production Hook event emission and real in-memory SQLite CLI history/state writes. MCP list/get metadata reads succeed without auth; all 16 external-disallowed guards remain effective. | `src/main/hook-server/server.ts:61` |
| coordination-02 | MEDIUM | Initialized Git submodule cwd resolves to the superproject's Git directory parent; real preparation creates the superproject worktree and real exit preflight rejects the stored repository identity. Isolated Git reproduction rerun passed. | `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts:87` |
| coordination-03 | MEDIUM | Session deletion/retention cascades tasks but leaves dangling UUID dependencies in another active owner's task. Three real SQLite cases reproduced, including an explicit-task-delete control and actual task_get output. | `src/main/store/session-repo/worktree-transition-delete.ts:31` |
| coordination-04 | LOW, confirmed dead | applyHandOffSkipPolicy, findOwnedDistinctTeamIds and reassignOwner(clear-team) are only reached through forwarding/tests; production transfer and rollback use preserve-team. Whole-repository caller checks confirmed the bounded removal family. | `src/main/store/task-repo/task-repo-handoff.ts:60` |
| remote-01 | HIGH | Supported 1,037,404-byte event response resets default Relay bridge after 196,608 response bytes. Production projector/daemon/bridge reproduction rerun passed. | `src/hosts/local-worker/frame-bridge.ts:258` |
| desktop-01 | HIGH, Windows condition | Selected sound filename is interpolated as PowerShell code. Actual command construction rerun and Microsoft PowerShell 5.1 quoting semantics agree. No native Windows execution; macOS/Linux unaffected by this path. | `src/main/notify/sound.ts:146` |
| runtime-01 | MEDIUM | Remote Claude approval reports resolved while supplying `{}` as tool arguments. Real Core-handler/responder reproduction rerun passed; Desktop explicit-input control preserves arguments. Counted once across tracks. | `src/main/adapters/claude-code/sdk-bridge/permission-responder-core.ts:68` |
| runtime-02 | MEDIUM | Strict Claude rollback waits before the cleanup that wakes/ends its reusable input stream. Real generator/lifecycle/cleanup reproduction fails at 1 second; ordinary close control succeeds. | `src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.ts:149` |
| runtime-03 | MEDIUM | Deleting a pre-echo Grok prompt leaves its RPC un-aborted. In the supported missing-terminal-response case, next prompt waits 90 seconds then runs on the old transport. Occurrence rate and subsequent event misattribution are unmeasured. | `src/main/adapters/grok-build/turn-queue.ts:160` |
| remote-02 | MEDIUM | Ordinary newline text rejects Feishu history and inbound prompts. Actual Core projection/gateway and installed SDK mapper reproduction rerun passed. | `src/gateways/im/core-bounds.ts:37` |
| remote-03 | MEDIUM | A group bot mention prefixes slash commands, causing `/select` failure or `/unsubscribe` to become a provider message. Installed SDK/mapper/gateway reproduction rerun passed. | `src/gateways/feishu/mapper.ts:201` |
| desktop-02 | MEDIUM | Local Diff retains its list while unsubscribed and skips refresh when reopened. Real hook reproduction rerun passed. | `src/renderer/components/SessionDetail/use-file-changes.ts:71` |
| desktop-03 | MEDIUM | A 51-file update burst leaves one of 52 revisions inaccessible because incremental refresh discards the new cursor. Real hook/immediate-response reproduction rerun passed. A separate speculative initial-load race is excluded. | `src/renderer/components/SessionDetail/use-file-changes.ts:59` |
| desktop-04 | MEDIUM | Older Remote selection appends a second mutation after a newer Local choice, persisting the wrong final source. Actual App callback and source hook reproduction rerun passed. | `src/renderer/App.tsx:385` |
| desktop-05 | MEDIUM | Browser `open --show` reaches a production no-op while returning visible true. Callback search and real executor/engine/view-host reproduction rerun passed; no live Browser used. | `src/main/browser-use/view-host.ts:189` |
| runtime-04 | LOW opportunity | One Codex pending turn is represented by three correlated arrays mutated by seven production modules. Shared queue-element ownership can remove current padding/splice coordination; no metadata corruption claimed. | `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:273` |
| desktop-06 | LOW opportunity | Local/Remote Diff duplicate loading/merge/cursor state and already have divergent behavior. Consolidate state logic while retaining source authorization; linked to desktop-02/03, not another user defect. | `src/renderer/components/SessionDetail/RemoteDiffPanel.tsx:12` |
| LEAD-01 | LOW validation gap | Four native installer tests are omitted by default `pnpm test`. Correct `node --test` execution passed all four. Add a Node test step or migrate to Vitest. | `vitest.config.ts:27` |

The large-response, text-validation and source-intent findings also identify concrete ownership/contract costs. They should inform their bounded repairs rather than create extra duplicate architecture findings.

## External language evidence

The lead independently opened [Microsoft PowerShell 5.1 quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-5.1#double-quoted-strings). Double-quoted strings evaluate subexpressions; filename interpolation in desktop-01 therefore crosses a data/code boundary. The command-construction probe does not execute PowerShell.

## Validation state

- Integrated typecheck/architecture, deployment static checks and entrypoint graph passed.
- Lead existing tests: 29 deployment and 4 native installer tests passed.
- Worker existing tests: remote 41, runtime 41, desktop 37 passed (reported exact file sets in their reports; no aggregate whole-suite claim).
- Lead reran remote 3, runtime 3, desktop 6 probes; all reproduced current behavior. One extra desktop synthetic race is intentionally excluded from accepted findings.
- Lead independently ran one production Hook probe, which reproduced the authentication bypass.
- Coordination's 118 existing tests passed; the lead reran all seven supplied isolated probes. The SQLite binding fingerprint remained unchanged.
- All four worker reports and required evidence are consumed and accepted; all four worker sessions were closed through Agent Deck.
- No new confirmed dead production module: 1,602 reachable modules and 17 currently used test fixtures. coordination-04 is method/branch-level dead code inside a live module. Current preserve-team transfer, ordinary dependency cleanup and Browser/recovery/identity boundaries remain live.
