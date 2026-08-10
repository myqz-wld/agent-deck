---
plan_id: PLAN_34
title: Managed Relay, Worker, and Full deployment automation
status: completed
created_at: 2026-08-10
updated_at: 2026-08-10
completed_at: 2026-08-10
base_branch: main
base_commit: a4b271a6d97a8c3e8839c6a1f70dcdfb735562f4
related_changelog: CHANGELOG_584
related_review: REVIEW_222
---

# Managed Relay, Worker, and Full deployment automation

## Goal

Provide repeatable, fail-closed scripts for Relay server, local Relay Worker, and Full server
deployment from an exact current Agent Deck release.

## Invariants

- Use the existing instance manager as the only Full/Relay server lifecycle authority.
- Pin every server image by immutable SHA-256 digest.
- Keep secrets in canonical mode-0600 files and out of argv, logs, and repository examples.
- Run child processes with argv arrays and `shell: false`.
- Treat the optional Remote Grok Provider supervisor as a separate lifecycle.
- Do not mutate the currently deployed Relay during acceptance.
- Keep the Relay Worker Workspace outside the Agent Deck repository.

## Delivered scope

- Added an executable private-JSON interface for the packaged Linux instance manager, including a
  deployment-only `describe` command for generation, version, image, unit digest, and resources.
- Added strict shared configuration, process, SSH, release, evidence, secret, server, and Worker
  modules plus three public package entrypoints.
- Added exact examples and documentation for supported actions, prerequisites, migrations,
  credentials, evidence attestations, and the optional Provider supervisor boundary.
- Added focused tests and integrated deployment checks into `verify:linux-headless`.

## Decisions

- Mutating server actions require `/var/lib/agent-deck`; legacy home directories remain eligible
  only for read-only verification and are never silently adopted.
- Relay images are built remotely from the exact clean, upstream-aligned commit and a pinned Node
  base digest. Full consumes a separately built digest-pinned appliance image.
- Full secrets are initialized only after the manager creates the labeled secrets volume, without
  placing contents in process arguments. Upgrade and rollback leave that volume untouched.
- Worker deploy delegates to the installed signed `agent-deck-worker`; upgrade revalidates and
  restarts it. Binary rollback remains an explicit signed-app reinstall, not a fake generation.
- Egress and quota booleans are operator attestations. Automation binds evidence to the exact
  instance, generation, version, image, rendered unit digest, and declared resource limits.

## Validation and acceptance

- Typecheck, the full test suite, production build, Linux headless build/package/static checks,
  deployment syntax/static checks, and whitespace checks passed.
- The current AWS Relay passed read-only systemd, container, pinned-image, and health verification.
- The installed macOS Worker passed read-only verification and is running from the isolated
  home-directory Workspace.
- No live Full target or appliance image was supplied, so Full remains ready for first-host
  acceptance rather than being represented as production-deployed.

## Residual boundaries

- Existing unmanaged instances need a separately designed migration or a new managed instance
  before lifecycle mutations can use these scripts.
- The scripts record independently verified egress/quota assertions; they do not create those host
  controls from an ordinary rootless network or filesystem.
- Provider supervisor provisioning and dedicated Remote Grok credentials remain optional and
  external to these three entrypoints.

## Final status

Completed. Relay server, isolated Worker, and Full server deployment now have reusable and tested
entrypoints, with the existing Relay/Worker accepted read-only and Full acceptance explicitly
deferred until a real target is supplied.
