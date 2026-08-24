---
changelog_id: 626
changed_at: 2026-08-23
---

# CHANGELOG_626_new-session-sandbox-label: Align new-session sandbox labels

## Summary

The new-session form now labels the sandbox field consistently as `沙盒` for Claude Code, Codex
CLI, and Grok Build sessions in both Local and Remote sources.

## Changes

- Replaced the Claude Code `系统沙盒` and Grok Build `Grok Build 沙盒（请求档位）` field labels
  with the shared `沙盒` copy.
- Kept adapter-specific choices, descriptions, and runtime behavior unchanged.
- Added focused coverage that locks all three adapter sandbox fields to the same label.

## Validation

- Focused new-session option catalog coverage: 1 file and 5 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,002 files and 6,268 tests passed; 2 files and 3 tests skipped.
- `git diff --check`

## Do Not Split Protection

None. Both changed renderer files remain below 500 lines.

## Notes

This is a renderer-only copy alignment. Existing README guidance does not name these field labels,
so no documentation update was required.
