---
review_id: 191
reviewed_at: 2026-07-29
baseline_commit: 15537b6b206b2d26aa5b1c4c18b9f722cae75d44
expired: false
---

# REVIEW_191_expandable-dialog-close-control: Compact dialog close control

## Scope

Review and refine the oversized close control in the shared full-screen expandable-content header.

```review-scope
src/renderer/components/expandable-content/ExpandableContent.tsx
src/renderer/components/expandable-content/__tests__/ExpandableContent.test.tsx
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| LOW | The shared close control used a 44px square target and 16px SVG, giving the lightweight header action excessive visual weight next to its 14px title. | Reduced the desktop control to 32×32px and the SVG box to 12×12px while preserving its label, tooltip, hover treatment, keyboard focus outline, and disabled state. |

## Evidence

- The reported screenshot showed the close action visually dominating the right side of the
  `重现步骤` header.
- An isolated renderer preview of the same input-variant expandable dialog confirmed the smaller
  close mark remains visible, aligned, and visually subordinate to the title.
- The focused shell test asserts the button and SVG sizing while retaining the existing close and
  focus-cycle coverage.
- `bash scripts/file-level-review-expiry.sh` completed before finalization.

## Validation

- Focused expandable-content suite passed: 8 tests.
- `pnpm typecheck` passed.
- Full Electron-ABI suite passed: 468 files passed, one skipped; 4,000 tests passed, one skipped.
- Both changed files remain below the 500-line guardrail.

## Fixes landed

- Reduced the shared expandable-dialog close button from `h-11 w-11` to `h-8 w-8`.
- Reduced its close icon from `h-4 w-4` to `h-3 w-3`.
- Added regression assertions for both dimensions.

## Residual risk

None identified. The 32px desktop target remains larger than the icon and preserves the existing
interaction and accessibility semantics.

## Follow-up

None.
