---
review_id: 309
reviewed_at: 2026-09-30
baseline_commit: d524f135622358e44d3a2aca59b0683b3e4202fe
expired: false
---

# Feishu assistant voice refinement

## User Custom Points

None. The one-time voice adjustment is not stored as a new reusable custom rule.

## Confirmed scope and changes

The owner previously confirmed the exact shared conversation-prompt.ts file and its assistant
persona section, then explicitly requested a less stiff catgirl voice after a real directory
creation reply appended a catchphrase to an identifier. That existing exact-file authorization
and the new requested refinement cover the edit; no tool-description scope expansion is needed.

Rewrite assistant voice guidance around everyday phrasing, sparse contextual catchphrases, clean
technical identifiers and concise confirmations after work cards. Keep the original initial/update
turn mechanism, but avoid announcing persona settings. Advance setup to version 2 so existing
assistants receive the revision once through the established idempotency key and retain history.

```review-scope
src/gateways/im/conversation-prompt.ts
src/gateways/im/assistant-setup.ts
src/gateways/im/assistant-setup.test.ts
src/gateways/im/conversation-router.ts
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
```

Only conversation-prompt.ts and the version-upgrade regression changed. The work prompt and every
management/permission rule are byte-preserved. Claude/Codex resources are check-only and unchanged;
all adapters consume the same Feishu assistant template, with native runtime differences retained.

## Validation

- Prompt Asset Improver inventory is local, ignored, freshly scanned with seven-day expiry and
  post-edit hashes. There are no prompt links or bundled file references to repair; no skill or
  external-source validation applies. No new pitfall notes or global project policy were added.
- Both unversioned and version-1 assistants receive one update without a new conversation or a
  work-target change. Existing replay identity, explicit unsubscribe and initial setup tests pass.
- 19 focused and 6,919 full tests pass, with six existing skips. Type/architecture, headless/native
  builds, headless/deployment checks and archive privacy checks pass. SQLite binding is preserved.
- Local source inspection only; no independent-agent review claim. Review expiry was checked
  during this bounded follow-up. Unrelated expired coverage is not waived by this record.

## Residual risk

Tone is model-generated; automated checks establish update behavior, not subjective naturalness.
Managed Feishu activation passed in
[PLAN_78](../../plans/recent-3-days/PLAN_78_feishu-operations-approval-activation.md). The owner
subsequently supplied a natural greeting and correct retained test-word reply; activation and
history preservation are live-observed. No Desktop or
Worker replacement is needed. The older no-reply investigation is deferred at the owner's request.

Related change: [CHANGELOG_667](../../changelogs/recent-3-days/CHANGELOG_667_feishu-assistant-voice.md).
