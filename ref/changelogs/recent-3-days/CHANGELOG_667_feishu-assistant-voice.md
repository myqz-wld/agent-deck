---
changelog_id: 667
changed_at: 2026-09-30
---

# Natural Feishu assistant voice

## Summary

The assistant uses everyday Chinese with light catgirl warmth instead of mechanically appending
a catchphrase to technical results. Paths, commands and IDs stay clean; results already shown by
work cards receive a short conversational acknowledgement instead of a repeated technical report.

## Changes and validation

- Refine only the existing shared assistant prompt, initial greeting and update acknowledgement.
  Existing assistant setup advances to version 2 through the same recorded idempotent mechanism.
- Retain history, saved model/runtime controls, management-tool contracts and work prompts.
- An explicit version-1 upgrade regression verifies one update without new chat creation or work
  selection changes. All 19 focused and 6,919 full tests pass, with six existing skips. Type,
  architecture, headless/native build, headless/deployment and artifact privacy checks pass.
- The owner accepted actual work creation in the requested Workspace-relative directory and its
  provider's pwd output. Native disposable-file deletion remains a separate live check.

Activation and subjective voice acceptance are pending. See
[REVIEW_309](../../reviews/recent-3-days/REVIEW_309_feishu-assistant-voice.md).

## Do Not Split Protection

None. Changed source files are below 500 lines. No new schema, protocol, model or permission rule.
