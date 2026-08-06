---
changelog_id: 503
changed_at: 2026-08-05
---

# CHANGELOG_503_claude-jsonl-discovery-core-boundary: Port recovery transcript probes

## Summary

Claude recovery transcript and cwd probe policy now runs in a host-neutral Core. Desktop home/path
encoding and filesystem metadata remain behind one host while resume fallback and phantom-fork
freshness semantics stay stable.

## Host-neutral JSONL discovery Core

- Added `jsonl-discovery-core.ts` with resume transcript existence, transcript mtime, and cwd
  existence decisions over explicit host probes.
- Preserved fail-open existence semantics: transcript/cwd path or filesystem errors let the SDK make
  its authoritative resume/path decision instead of introducing a preflight false negative.
- Preserved fail-closed freshness semantics: missing or unreadable transcript mtime returns `null`
  and cannot satisfy the read-side phantom-fork freshness gate.

## Thin desktop host and stable facade

- Added `jsonl-discovery-host.ts` as the sole owner of home-directory lookup, Claude project-path
  encoding, path joining, existence checks, and file stat metadata.
- Reduced `jsonl-discovery.ts` to stable Core/Host delegation used by `SessionRecoverer` without
  changing its overridable facade methods.
- Added direct Core tests for exact path forwarding, both existence-error seams, mtime success/error,
  and cwd fallback; added a direct desktop-host path and filesystem-probe test.

## Executable boundary gate

- Added a direct-import rule rejecting the stable discovery facade, desktop host, platform/path
  helpers, repositories, Node built-ins, Electron, and electron-log from JSONL discovery Core.
- Added Claude JSONL discovery Core as the sixty-eighth executable Node 22 boundary candidate.

## Validation

- Focused Core/host, restart preflight, JSONL fallback, and recovery coverage: passed, 5 files / 63
  tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-eight Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 701 files / 4,941 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep JSONL discovery Core, desktop host, stable facade, direct-import rule, and recovery tests
together. Existence uncertainty must remain fail open to the SDK, mtime uncertainty must remain
`null`, and transcript paths must continue using the platform-owned Claude cwd encoder.

## Remaining boundary

Claude recovery transcript/cwd probe policy is now host neutral. The wider provider output stream
plus concrete provider composition/repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
