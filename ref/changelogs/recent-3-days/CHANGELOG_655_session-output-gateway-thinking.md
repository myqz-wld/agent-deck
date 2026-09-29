---
changelog_id: 655
changed_at: 2026-09-29
---

# Readable tool output and Gateway thinking defaults

## Summary

Tool output now presents file contents, command streams, and MCP text directly, with the complete
structured result available in an expandable raw-data disclosure. New-session Claude defaults
recognize environment effort in Gateway settings, including environment-only `max` configuration.

## Changes

- Share Claude effort parsing between Desktop defaults and the Remote provider catalog. Resolve
  configured environment effort before settings effort and retain the existing `high` fallback.
- Isolate explicit thinking choices by adapter and Gateway. Refresh model and thinking defaults
  when switching Gateways, while preserving manual edits made during a pending read.
- Show stdout and stderr separately, preserve real newlines, retain unknown result structures,
  and keep raw results, failure details, images, and truncation information accessible.
- Combine Claude MessageDisplay deltas by message identity. Replace corresponding displayed text
  with the final reply within the same prompt/turn, without mutating persisted hook events.
- Hide empty task metadata and empty detail controls; show positive durations below one millisecond
  as `<1ms` while preserving actual zero and missing values.
- Keep the existing raw input disclosure. No thinking-source labels were added, as requested.

## Validation

- `pnpm typecheck` passed, including architecture checks.
- `pnpm test` passed: 1,078 files and 6,663 tests; two files and three tests skipped.
- `pnpm build` passed.
- The Electron SQLite binding checksum was identical before and after the full suite.
- Session Browser snapshots and inspected screenshots verified actual production-built components
  using synthetic data: DeepSeek selection displays MAX, file and command output retain newlines,
  raw data expands, MCP output is readable, and the external reply appears once without empty tasks.
- `git diff --check` passed.

## Do Not Split Protection

None. Every changed source file remains below 500 lines; new presentation helpers are separate
modules with stable component consumers.

## Notes

The installed application was not replaced or restarted. Provider-network requests and deployment
were outside this change. See [REVIEW_296](../../reviews/recent-3-days/REVIEW_296_session-output-gateway-thinking.md)
and [PLAN_65](../../plans/recent-3-days/PLAN_65_session-output-gateway-thinking.md).
