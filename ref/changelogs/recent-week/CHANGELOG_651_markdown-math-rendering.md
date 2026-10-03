---
changelog_id: 651
changed_at: 2026-09-28
---

# Markdown Math Rendering

## Summary

Render mathematical formulas in the shared Markdown component used by Claude, Codex, Grok,
messages, and plan views. Keep the existing per-message Markdown/plaintext controls and the
English `REASONING SUMMARY` / `THINKING` labels.

## Changes

- Add `remark-math`, `rehype-katex`, and the matching KaTeX 0.16 styles/fonts. Assets are bundled
  locally; formula rendering does not require a CDN or network access.
- Support inline `$...$` and `\(...\)`, display `$$...$$` and `\[...\]`, and fenced `math` blocks.
  Same-line double-dollar equations use display layout as well.
- Register backslash delimiters in Markdown tokenization so TeX commands and subscripts survive
  parsing, while inline code, ordinary code fences, and link destinations remain literal.
- Apply whitespace and trailing-digit boundaries to single-dollar math. Amounts such as
  `$5 and $10` remain text without consuming a later formula's opening delimiter.
- Constrain display equations to their message width and allow horizontal scrolling. Preserve
  malformed formula source and allow later valid equations to render.
- Keep raw HTML disabled and KaTeX trust disabled. Bound macro expansion and user-specified size.
- Document the supported syntax in README. No adapter, IPC, database, or host lifecycle changes.

## Validation

- `pnpm typecheck` passed, including architecture checks and both TypeScript projects.
- Full `pnpm test`: 1,042 files and 6,477 tests passed; 2 files and 3 opt-in tests skipped.
- Focused math coverage: 13 tests passed, including three additional container/incomplete-input
  regressions run after the full suite. Covers GFM coexistence, four display spellings, matrix
  line breaks, block quotes/lists, currency, code, link destinations, malformed input, and trust.
- `pnpm build` passed. All 59 emitted KaTeX font URLs resolve to local build assets; generated CSS
  includes the bounded formula layout and no external KaTeX URL.
- The Electron-compatible test wrapper left the better-sqlite3 binding checksum unchanged.
- Agent Deck Browser rendered the real Markdown component in a synthetic, 360px-wide local
  preview. Screenshot inspection confirmed inline formulas, integrals, matrices, and cases.
  Fonts reported loaded. The long equation had a 322px viewport and 384px scrollable width;
  neither its card nor the page overflowed. The background test tab was closed afterward.
- `git diff --check` passed. This did not install over or restart the running application.

## Do Not Split Protection

None. Math syntax and layout are separate small modules; changed source files remain below 500 LOC.

## Notes

- KaTeX supports a mathematical TeX subset, not complete LaTeX documents. Unsupported formulas
  fall back to readable source.
- The visual check used a synthetic component preview, not a live provider conversation.
- Provider-specific presentation recommendations are recorded separately in
  [the content audit](../../reviews/recent-week/REVIEW_283_session-content-presentation.md).
- Integration follows the [remark math documentation](https://github.com/remarkjs/remark-math)
  and [KaTeX options](https://katex.org/docs/options.html).
