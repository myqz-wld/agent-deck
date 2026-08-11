---
review_id: 227
reviewed_at: 2026-08-10
baseline_commit: 17c31ec7b743f7f1356eba958da8add7473ae1ab
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog maintenance are mechanical records."
---

# REVIEW_227_remote-source-reconnect: Persisted Remote source restoration

## Scope

```review-scope
src/renderer/remote-host/use-remote-host-snapshot.test.tsx
src/renderer/remote-host/use-remote-host-snapshot.ts
```

## Finding

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Startup restored the persisted Remote selection but never connected its profile. The initial offline snapshot therefore carried no capabilities, hiding Teams, Issues, and Data while leaving the session total and Remote usage rates unavailable. | Add one active-source-scoped connection attempt with explicit-disconnect, retry-loop, and stale-source guards. |

## Root cause and production evidence

- `RemoteHostProfileController` registered and selected persisted profiles during construction but
  intentionally did not initiate transport work.
- `useRemoteHostSnapshot` loaded that offline state without restoring the active Remote transport.
- The renderer correctly gates Teams, Issues, and Data on negotiated capabilities, and exposes an
  authoritative total and usage only after the Remote source is connected. An empty offline
  capability set therefore produced the exact reduced UI reported by the user.
- Production Relay capability probing independently returned protocol 2.1, 21 capabilities
  including Teams, Issues, and Usage, and an authoritative live session total of 4. This excluded
  server capability clipping as the cause.
- The user's manual reconnect coincided with a Worker attachment recovery window: the persisted
  source changed back to Local at 20:45 and the current Worker SSH attachment started at 20:46.
  Subsequent official Relay and Worker verification passed. Because the renderer consumes the
  sanitized connection error without writing it to the main log, the exact transient UI code could
  not be recovered after the dialog changed; this timing is correlation rather than proof.

## Fix review

- The effect runs only for the selected profile of an active Remote source whose state is exactly
  offline.
- A per-profile attempt fence treats connecting/reconnecting/connected as already owned and blocks
  repeated attempts after a failure or explicit disconnect.
- Switching to Local clears that fence, allowing the next intentional Remote selection to connect.
- Late failures are compared with the current active Remote profile before changing visible error
  state, preventing a stale error after a source switch.
- Successful snapshots still pass through the existing monotonic revision guard.

## Validation

- `pnpm test` passed 876 files and 5,709 tests; 2 files and 3 tests were skipped.
- Four focused Remote source suites passed 28 tests.
- `pnpm typecheck` passed architecture and Node/Web TypeScript checks.
- `pnpm build` passed.
- `bash scripts/file-level-review-expiry.sh` completed before this review.
- `git diff --check` passed; both reviewed files remain below 500 lines.
- Official Relay Server and Worker verification passed without process manipulation.

## Residual risk

- A transient Worker-offline interval can still make the single attempt fail visibly. The transport
  remains fail-closed and the user can retry after Worker recovery; automatic unbounded retries are
  intentionally excluded.
- Main-process logs do not currently retain the renderer-visible sanitized connect error. The UI
  remains authoritative for that exact failure text.

## Verdict

PASS. The fix restores the selected Remote source without weakening explicit disconnect semantics,
transport ownership, source isolation, or revision fencing.
