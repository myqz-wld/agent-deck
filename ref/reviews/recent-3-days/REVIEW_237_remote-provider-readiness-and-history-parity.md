---
review_id: 237
reviewed_at: 2026-08-12
baseline_commit: 50ddf644f9e08803ed40d00b5237f2327c113364
related_changelog: CHANGELOG_597
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record, changelog, rebucketing, and index maintenance are mechanical."
---

# REVIEW_237_remote-provider-readiness-and-history-parity

## Scope and method

This review reproduced the installed Remote provider states over the existing authenticated SSH
profile, traced the Server Core quota composition and Local Worker credential projection, compared
Local and Remote History card structures, and landed bounded fixes with negative credential tests.
No credential value, refresh token, account identifier, SSH key, or Worker-private path was printed
or added to source control.

```review-scope
deploy/linux/provider-session/README.md
deploy/linux/relay/README.snippet.md
src/hosts/local-worker/provider-credential.test.ts
src/hosts/local-worker/provider-credential.ts
src/hosts/server-core/provider-codex-host.test.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/usage-runtime.test.ts
src/hosts/server-core/usage-runtime.ts
src/renderer/components/HistoryPanel.tsx
src/renderer/components/LocalHistorySummaryCard.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/SessionMetadataChips.tsx
src/renderer/components/__tests__/HistoryPanel.parity.test.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | The Server Core Codex bridge returned a hard-coded “quota probe disabled” snapshot even though the Electron-free app-server client and private Codex auth projection were already present. | Bind the existing `account/rateLimits/read` probe to the Worker-private provider home, bundled Codex executable, and provider temp directory. |
| MEDIUM | The Core imposed a five-second provider quota timeout while all three cold background probes allow up to fifteen seconds. | Raise the outer safety fence to twenty seconds; the Desktop request retains its forty-five-second deadline. |
| MEDIUM | Current Grok CLI login writes one OIDC account document, while the Worker installer accepted only the older dedicated `xai::cached` schema. | Accept one unambiguous, unexpired native OIDC account and project only `auth_mode`, access token, and expiry into the exact Core schema. Refresh token and account/profile metadata remain in the source login file. |
| LOW | Local History used an older bespoke row while Remote History used the shared session-card presentation. | Both paths now use the same frame, header, source badge, runtime metadata, context, activity, and summary structure; Local-only archive/delete actions live in a compact card menu. |

## Validation and evidence

- The installed release reproduced Codex as `unavailable` with the exact Core-disabled message;
  projected source and Worker auth files were byte-identical, ruling out stale Codex auth.
- The current real Grok OIDC login projected successfully to exactly `auth_mode`, `key`, and
  `expires_at`, with no refresh/profile fields in the output. Official Worker credential and
  deployment checks passed.
- The configured Remote Core reported `grok-build` creation enabled with all three Remote sandbox
  choices enabled after the credential installation; Worker and Provider supervisor health both
  reported running.
- Focused Electron-ABI regression coverage passed 11 files / 59 tests; the first correction sweep
  passed 5 files / 30 tests.
- The complete Electron-ABI suite passed 945 files / 6,059 tests; 2 explicit live/environment
  files / 3 tests remained conditionally skipped.
- Node and Web TypeScript checks, architecture/Core-node boundaries, deployment automation,
  Relay/Full static checks, Linux headless build/check, renderer/main/preload production build,
  `git diff --check`, and the 500-line production-file gate passed.

## Residual risk

- The installed application used for the initial live probe predates the Codex quota and provider
  timeout fixes. A freshly packaged Worker must be installed/restarted before the live Codex quota
  result can validate the new path.
- A healthy Grok creation capability proves supervisor/container/credential readiness; provider
  billing availability remains an independent network/API surface and may still return an honest
  unavailable snapshot.
- Local History retains Local-only mutation affordances, while Remote History remains read-only;
  capability differences are intentional even though the visual hierarchy is shared.

## Verdict

PASS WITH INSTALL ACCEPTANCE PENDING. Source, tests, packaging, and the live Grok readiness boundary
converge. The remaining acceptance action is installing this exact build and re-reading Remote
Codex/Grok quota snapshots.
