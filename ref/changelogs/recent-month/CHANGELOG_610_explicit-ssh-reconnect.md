---
changelog_id: 610
changed_at: 2026-08-13
---

# CHANGELOG_610_explicit-ssh-reconnect: Rebuild an exhausted SSH connection

## Summary

Clicking Connect after an SSH channel has exhausted its automatic retries now creates a fresh
channel instead of returning the terminal error retained by the old client.

## Changes

### Explicit reconnect

- Retire an offline SSH binding before handling an explicit Connect request.
- Install a fresh SSH client and start a new handshake after the previous retry chain has ended.
- Coalesce repeated Connect clicks while the replacement channel is being created.
- Preserve a healthy Relay channel when only its Worker is temporarily unavailable.

### Regression coverage

- Exercise a real SSH client binding through initial connection, terminal child exit, explicit
  reconnect, replacement handshake, and Worker generation update.
- Verify that concurrent Connect calls share one replacement attempt and do not create extra SSH
  children.

## Validation

- `pnpm typecheck` passed, including both architecture boundary checks.
- Five focused registry and Remote lifecycle suites passed with 35 tests.
- The complete Electron test suite passed: 960 files and 6,142 tests, with only opt-in smoke tests
  skipped. An isolated rerun also passed all 18 Remote dialog tests after an earlier timing failure.
- `pnpm build` passed.
- The live Relay deployment verification and an exact read-only SSH bridge probe both succeeded.
- No application, Relay, or Worker process was stopped or restarted during diagnosis.

## Do Not Split Protection

No exception is required. Every changed production TypeScript file remains below 500 lines.

## Related review

- `ref/reviews/recent-3-days/REVIEW_244_explicit-ssh-reconnect.md`
