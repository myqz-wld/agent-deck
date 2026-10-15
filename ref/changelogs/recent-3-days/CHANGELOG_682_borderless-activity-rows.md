---
changelog_id: 682
changed_at: 2026-10-14
---

# Restore Plain Activity Rows

## Summary

Ordinary timeline events, including session start and turn completion, return to the original
borderless layout with light text and a secondary timestamp. They no longer look like chat cards.

## Changes

- Restored the plain `SimpleRow` presentation for session, turn, subagent, and fallback events.
- Retained neutral interruption styling, red failure text, and collapsed details.
- Kept the dedicated compaction presentation and ordinary system-message bubbles.
- Kept README concise; no additional implementation details were added.

## Validation

- Typecheck passed.
- Existing activity-feed regression tests: 139 passed.
- Browser DOM inspection of the actual rendered component confirmed zero-width borders,
  transparent backgrounds, light ordinary text, and red failure text. Screenshot capture was
  unavailable; no image-based verification is claimed.
- `git diff --check` passed.
- Temporary validation material uses the system temporary directory; `.ref` stays empty.

## Do Not Split Protection

None required; modified source files remain below 500 lines.
