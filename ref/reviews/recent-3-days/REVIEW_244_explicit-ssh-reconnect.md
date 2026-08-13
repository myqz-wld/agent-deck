---
review_id: 244
reviewed_at: 2026-08-13
baseline_commit: 45660a7d40fe1ce483a78fd53d6f9645aa5b3b06
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical evidence derived from the reviewed tree."
---

# REVIEW_244_explicit-ssh-reconnect: Explicit SSH reconnect lifecycle

## Scope and method

This review traced SSH terminal state, automatic retry exhaustion, registry binding ownership,
explicit Connect coalescing, Relay Worker-offline handling, binding retirement, and the Remote
service lifecycle. It reproduced the failure from application logs, verified the deployed Relay
without changing it, and exercised the replacement path with a real SSH client binding and mocked
child processes.

```review-scope
src/hosts/electron/registry-reconnect.ts
src/hosts/electron/registry-resilience.test.ts
src/hosts/electron/registry.ts
```

## Findings

### HIGH — Connect reused an SSH client whose retry chain had terminated

After the SSH child exited and automatic retries were exhausted, the client retained a terminal
error and rejected every later `connect()` call. The registry kept that binding for retryable
connection failures, so clicking Connect repeatedly returned the same old error without spawning a
new SSH channel. Explicit Connect now retires an offline terminal binding, waits for cleanup, and
installs a fresh client before starting the handshake.

### MEDIUM — Replacement could break Connect request coalescing

Normal binding retirement clears the registry's in-flight Connect promise. Doing that from inside
the replacement Connect operation would let a second click create a competing attempt. The explicit
replacement path preserves the public promise while retiring the old binding, so all clicks during
the rebuild join one operation.

### MEDIUM — Relay Worker unavailability must not be mistaken for a dead SSH channel

A Relay can remain connected and authenticated while reporting that its Worker is unavailable.
Replacing that live channel would turn a Worker recovery condition into unnecessary SSH churn. The
replacement predicate excludes the existing Worker-offline state when a valid Relay hello remains
available.

## Validation and evidence

- Focused registry and Remote lifecycle validation: 5 files and 35 tests passed.
- Explicit reconnect coverage proves one replacement binding, one coalesced promise, and a new
  Worker generation after the replacement hello.
- `pnpm typecheck`: passed, including the Core and renderer architecture gates.
- `pnpm test`: 960 files passed, 2 skipped; 6,142 tests passed, 3 skipped. An isolated rerun also
  passed all 18 Remote dialog tests after an earlier timing failure.
- `pnpm build`: passed.
- Managed Relay verification reported healthy, and a bounded read-only bridge probe completed the
  current SSH authentication and stayed connected until the diagnostic timeout.
- No running application or remote service process was killed, restarted, installed, or deployed.

## Fixes landed

- Explicit Connect replaces only an offline terminal SSH transport.
- A live Relay connection that reports Worker unavailability remains reusable.
- The replacement lifecycle keeps one shared Connect promise until completion.
- Regression coverage follows the complete old-child-exit to new-handshake sequence.

## Residual risk

The currently installed application still contains the previous behavior until this source change
is packaged and installed. That installation was deliberately not performed because validation did
not require disrupting the running application.

## Follow-ups

None required for this scope.
