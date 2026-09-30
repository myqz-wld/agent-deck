---
review_id: 305
reviewed_at: 2026-09-30
baseline_commit: 3c90554c025986c4cf806c0a88699d9a6c461bb8
expired: false
---

# Native approval delivery depth

## Scope and method

Local producer/consumer tracing, a read-only live pending probe and synthetic regression tests.
No additional agents or independent review claim. The expiry script was attempted; legacy
incomplete coverage remains outside this bounded review. Both changed files were reviewed.

```review-scope
src/gateways/im/core-output.ts
src/gateways/im/pending-native-depth.test.ts
```

## Finding and repair

HIGH: A native create_work_session request waits for approval, but its Feishu notification fails
before transport. The 3,183-byte live request contains a structured model selection in
tool_params_display; the complete pending.list wrapper reaches depth nine against the generic
depth-eight limit. A private read-only production-bundle probe isolates this validator and proves
the same request renders as an actionable 2,236-byte card when the wrapper budget is sufficient.

Fixed wrappers now receive their own bounded allowance. Each pending display is independently
validated; permission input retains the configured payload depth budget. Aggregate bytes, entries,
field lengths and request counts remain unchanged. No unknown fields, non-JSON values or control
characters are accepted. Other Core response validators are unchanged. The original complete
display reaches signing and callback verification without normalization or parameter removal.

## Validation

- Nine focused cases pass: native structured metadata, configured depth boundaries, aggregate
  limits, malformed values, notification delivery and changed/unchanged approval callbacks.
  Old-source reproduction rejects valid pending input and fails both delivery cases.
- Full suite: 6,892 passed and three existing skips (1,116 passing files, two skipped).
  The first concurrent run hit an unrelated RemoteIssuesPanel polling timeout; an unchanged full
  rerun passes. No renderer or timeout changes were made.
- Typecheck/architecture, headless build/check and deployment checks pass. The Electron SQLite
  binding remains unchanged. Both changed files stay below 500 lines.
- Both native runtime archives pass checksum, membership and privacy inspection (26 regular files
  each); all 11 headless bundles pass the same private-path check. No Desktop package is built.

## Residual risk and acceptance

Managed Server/Feishu activation and the owner's actual approval remain pending at source review.
Preserve the current native request when possible; do not approve it or duplicate work for the
owner. No Desktop reinstall, database migration, model change, prompt change or pairing is needed.
The older warm-channel stall has a separate unproven cause and is not claimed as fixed here.
