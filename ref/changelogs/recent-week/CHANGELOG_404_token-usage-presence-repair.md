---
changelog_id: 404
changed_at: 2026-07-27
---

# CHANGELOG_404_token-usage-presence-repair: Restore daily token totals

## Summary

Daily token totals remain visible when historical or streaming Codex observations omit unrelated
metrics. The Data panel also renders output totals with the same neutral text color as input totals.

## Changes

### Historical repair

- Add migration v052 to repair the overly broad applicability masks assigned by v051 to historical
  non-Grok rows.
- Preserve strict Provider totals while allowing each retained input, output, reasoning, and cache
  fact to participate independently.
- Keep Grok excluded from the repair because an absent cumulative delta can represent a genuinely
  unknown value rather than a non-participating observation.

### New Codex usage

- Derive the metric applicability mask from the fields present in each app-server usage delta.
- Ignore empty initialization or recovery usage notifications.
- Keep Provider total applicable across partial Codex rows so it remains unavailable unless every
  contributing observation reports an exact total.

### Data panel

- Remove the green emphasis from output totals in both the daily summary card and detail table.
- Extract token-total formatting and card rendering so changed production files remain below the
  500-line guardrail.

## Validation

- `pnpm typecheck`
- `pnpm test`: 390 files and 3,284 tests passed; one credentialed live smoke remained skipped.
- `pnpm build`
- `pnpm logger:check`
- The arm64 `.app` packaged successfully, was ad-hoc signed, and passed strict deep signature
  verification.
- Production-database read-only simulation restored the populated July 21–27 Codex aggregates
  without modifying the live database.
- `git diff --check`

## Do Not Split Protection

None. Changed production files are below 500 lines; migrations and tests are exempt.

## Notes

Migration v052 applies automatically the next time a build containing this change starts. The
currently running installed application was not overwritten because doing so would terminate the
active Agent Deck session. DMG creation failed because macOS `hdiutil` returned resource-unavailable
after all retries; the incomplete DMG and blockmap were removed, while the verified `.app` remains
under `build/dist/mac-arm64/`.
