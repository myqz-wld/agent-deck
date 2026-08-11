---
review_id: 231
reviewed_at: 2026-08-11
baseline_commit: c3f15c7f89d47a0b3b140ed941402c4b2660c42b
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review maintenance is a mechanical final record."
---

# REVIEW_231_remote-replay-bootstrap: Remote replay bootstrap and Feishu gate

## Scope and method

This debug review traced a reproducible Remote connection failure from the installed desktop log,
the authoritative Worker Core metadata database, and the SSH subscription lifecycle. A newly
installed desktop advertised no durable cursor but the client converted that absence to revision
zero, requesting 514 retained events from a Core whose per-request replay maximum was 256. The
resulting `replay_gap` left the terminal binding installed, so the UI's reconnect action repeated
the same failure. The review also exercised the Feishu static acceptance gate while preparing a
real tenant test and found its exact root-script assertion had drifted from `package.json`.

```review-scope
deploy/linux/feishu/static-check.sh
src/clients/ssh/client-admission.test.ts
src/clients/ssh/client.ts
src/hosts/electron/registry-observers.ts
src/hosts/electron/registry-resilience.test.ts
src/hosts/electron/registry.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | A fresh desktop always subscribed from revision zero. Once the Core retained more events than the single-replay bound, Remote could not connect, and the terminal binding made the advertised reconnect action ineffective. | Treat an omitted initial cursor as a request to baseline at HostHello's authoritative current revision. Retire and identity-reset a binding after `replay_gap`, so the next explicit connect creates a fresh snapshot baseline. Preserve explicit nonzero cursors for genuine incremental recovery. |
| MEDIUM | The Feishu static verifier expected the obsolete two-stage `verify:linux-headless` command and rejected the current package-owned three-stage command. | Synchronize the exact assertion with `package.json`, retaining deployment checks in the Linux headless verification gate. |

## Correctness and safety disposition

- HostHello remains the snapshot boundary: list/detail APIs load current state, while subscription
  from the advertised revision captures events committed after that boundary without dropping the
  interval between hello and subscribe.
- Existing connections retain their explicit event cursor and replay semantics. The change does not
  silently skip a gap for a known cursor.
- A real `replay_gap` still fails closed and remains visible to the user. Only its terminal transport
  binding and stale Core identity are retired, allowing the user's next explicit connection attempt
  to establish a new snapshot.
- Core identity, capabilities, Worker generation, and revision are cleared together on retirement,
  preventing Remote renderer state from being attributed to the replacement connection.
- The change is desktop-only. It does not mutate Relay, Worker, Core history, credentials, or live
  processes and does not require a Relay/Worker redeployment.

## Validation

- Focused SSH and Electron registry validation passed 5 files / 33 tests, including a HostHello at
  revision 514 and a replay-gap reconnect that creates a second binding at revision 700.
- `pnpm typecheck` passed architecture, Core/Node boundary, Node, and Web checks.
- The full Electron test runner passed 901 files / 5,791 tests; 2 files / 3 tests were skipped.
- `pnpm build`, `pnpm check:linux-headless`, `pnpm check:deployment`, the Feishu static check, and
  `git diff --check` passed.
- Modified production TypeScript files remain below the repository 500-line limit.

## Residual risk and follow-up

- The installed desktop must be rebuilt and reinstalled before live verification because the fix is
  in the desktop SSH client and registry. The existing Relay and Worker should remain untouched.
- A live connection acceptance should verify that the first subscription uses the current Core
  revision, Remote reaches `connected`, and a normal subsequent reconnect resumes incrementally.
- Real Feishu acceptance remains an external configuration task requiring a disposable Feishu app,
  tenant identity mapping, dedicated Feishu Core credential, pinned host key, and mode-0600 secrets.

## Verdict

PASS. Fresh Remote bootstrap and replay-gap recovery are corrected without weakening known-cursor
continuity, and the Feishu deployment acceptance contract matches the current package script.
