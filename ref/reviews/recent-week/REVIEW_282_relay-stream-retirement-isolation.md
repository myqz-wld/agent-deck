---
review_id: 282
reviewed_at: 2026-09-29
baseline_commit: b9ee1bd71af44e3b90aab5d94dece332a1f33daf
expired: false
---

# Relay stream retirement isolation

## Scope

Follow up the intermittent SSH bridge rejection observed during
[Relay recovery](REVIEW_281_relay-runtime-directory-recovery.md). Diagnose the live failure and
repair the transport boundary in both Relay and Worker. No independent reviewers were requested;
the repository review-expiry inventory was consulted.

```review-scope
src/hosts/relay/router.ts
src/hosts/relay/control-host-retirement.test.ts
src/hosts/local-worker/frame-bridge.ts
src/hosts/local-worker/frame-bridge-retirement.test.ts
```

## Finding: HIGH — Stream retirement disconnects the shared Worker attachment

Before repair, with automatic retries disabled, three of sixteen production SSH connections failed
before receiving any response bytes. Successful connections read the session list and creation
descriptors. This was reproducible, not sufficient evidence for a network-only explanation.

A second live probe held one connection open while repeatedly connecting, reading, and closing a
separate connection. Closing a test connection disconnected the held connection and replaced the
Worker SSH child process. The Worker service itself stayed running. This explained why launchd and
Relay health checks passed while a subsequent handshake failed.

At the transport layer, stream closure and packets in flight travel independently. Relay immediately
removes the stream on client retirement; a later Worker frame for that stream throws out of the
attachment peer and terminates the shared Worker connection. Worker has the symmetric defect:
after Core closes a stream, a late Relay frame throws out of its frame bridge.

Eight deterministic regression cases fail on the original source: late data, credit, close, and
reset frames at each endpoint. The Relay cases also prove that an unrelated live client is affected.

## Repair

After validating the frame and authenticated attachment identity, ignore packets for a stream that
is no longer present. This matches the existing terminal-stream behavior in the client bridge,
does not retain an unbounded tombstone collection, and cannot reopen a stream. Invalid instance,
generation, and direction remain rejected; six additional regressions protect these boundaries.

## Validation and deployment status

- After the initial repair, 48 focused transport files and 268 tests passed, including the eight
  previously failing regressions.
- Exact-release validation in an isolated worktree passed typechecking and 6,467 tests, with
  three existing skips across 1,041 passing and two skipped test files. This supersedes the
  shared-checkout run, which included concurrent unrelated renderer changes.
- All 14 new regressions passed. Linux headless build/checks, both Feishu runtime builds, and
  macOS packaging passed. The four changed source/test files are below 500 lines.
- The macOS artifact contains clean source commit `b9ee1bd7`; its packaged Worker test and the
  mounted-DMG Worker ABI check passed. Scans of 272 application files, release archive members,
  nested payloads, and archive ownership found no local home paths or personal owner metadata.
- The initial macOS artifact had SHA-256
  `59ecf51501a5665f5596b4203fe8ba8d1bf1e51b25f6a1cea3fd806f9774f493`.
  It was superseded by the user's later installation of clean build `001a044e`; the old retained
  package is no longer present after that installation.
- The user reinstalled and restarted the application before final acceptance. The installed Worker
  now includes the repair; the four scoped source/test files are unchanged from `b9ee1bd7`.

## Deployment and disk recovery

Two official upgrade attempts failed before cutover with Podman exit 125 while committing the
layer containing `/usr/bin/node`: `io: read/write on closed pipe`. The root filesystem was 97% full
with about 229 MiB free. Recent kernel logs did not report OOM or filesystem I/O errors.

Following the user's cleanup request, downloaded package archives and old system journal archives
were cleared. The first cleanup left about 837 MiB free. The same committed release then passed
official check, dry-run, upgrade, and verify, supporting disk pressure as the deployment blocker.
No container images or retained runtime releases were removed.

The server now runs `git-b9ee1bd71af4`, managed generation 20, with image digest
`sha256:6f45e14ea115112309f0656ca00faef9c47bbf3415cffac94b3959ce1415c242`.
The previous `git-54a19a9de6a5` image is retained for rollback. Relay is active/running with zero
service restarts; official Worker and Provider supervisor verification also passes.

After the user explicitly allowed direct cleanup of old archives, the remaining archived journals
were removed and `apt-get distclean` cleared regenerable package indexes while preserving release
verification metadata. Active journals remain (56 MiB), and installed packages are unchanged.
Final root usage is 89%, with 856,018,944 bytes available (about 816 MiB), including the new release.
This is a one-time cleanup, not a permanent release-retention policy or disk expansion.

## Partial live acceptance on 2026-09-28

With the repaired Relay and the old installed Worker, the no-retry multi-client probe passed its
first connect/read/close cycle. On cycle two, the held connection was disconnected and the Worker
SSH child disappeared, then reconnected under the same Worker service process. The probe stopped
at that failure instead of repeatedly disrupting the shared attachment.

This remains consistent with the symmetric Worker defect established by the regressions. Worker
stdout/stderr did not acquire new diagnostic entries, so the live result is not a captured frame
trace of that endpoint. Relay health and Worker service status alone are insufficient acceptance.

## Final live acceptance on 2026-09-29

Installed clean build `001a044ee1ea7491385e1e15b049eeb65c96e3ae` includes the repair. The running
Worker and supervisor started after that build was installed. Official Relay verification and
Worker ABI/configuration checks passed. The server remains on the repaired generation-20 release,
active/running with zero service restarts. Root disk usage is 89%, with about 820 MiB available.

The live client disabled all automatic retries. Twenty cycles opened a fresh SSH connection, read
session listings and creation descriptors, and closed it while an independent connection stayed
online and successfully read again after every closure. Ten additional ordinary connection/read/
close cycles also passed. After the credential repair below, three more held-client isolation
cycles passed. Total: 33 successful test cycles, zero failures; 23 cycles checked cross-client
isolation. The Worker SSH attachment and both managed service processes kept the same identities
throughout; Worker stdout/stderr size and modification timestamps did not change.

## Operational follow-up: expired Grok credential projection

The initial acceptance cycles reported Claude and Codex available but Grok unavailable. Independent
checks confirmed a running container engine and supervisor capabilities with Grok available. The
Worker-private access-token copy had expired, while the configured native OIDC source credential
passed its official validation. The supported `agent-deck-worker install-provider-credential`
command atomically refreshed the exact Worker's copy. Grok then became available in all three
follow-up isolation cycles, without restarting either managed service or changing the SSH
attachment. No credential values or account metadata were retained in this evidence.

At the time of live acceptance, official Worker verification checked the source credential and supervisor transport;
it can report healthy while the deployed credential copy is expired. Its generic capability error
also attributes this case to isolation availability. Host-owned synchronization and verification of
the deployed copy are tracked separately in Agent Deck follow-up issue
`611fdd74-7a9f-4f61-af96-d85961696739` (medium). Refresh tokens must remain outside the Worker
projection. The credential recovery performed here does not implement automatic renewal.
Source synchronization, deployed-copy verification, and precise capability reasons are now implemented
and packaged in [REVIEW_287](REVIEW_287_grok-credential-projection-refresh.md); installed activation
remains pending host application replacement approval.

## Residual limits

Both endpoints contain the stream-retirement repair, and its live transport acceptance passed.
Provider model turns and a host reboot were not exercised. Credential renewal/health reporting
remains the separately tracked follow-up above. This record does not claim that every Relay or
provider behavior has been exhaustively validated. Temporary live-probe scripts remain intentionally
non-final because the user requested implementing the credential follow-up immediately.

Source integration and the completed acceptance are recorded in
[PLAN_59](../../plans/recent-week/PLAN_59_relay-handshake-investigation.md).
