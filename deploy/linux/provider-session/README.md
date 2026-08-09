# Provider session image

`Containerfile.grok.in` is a render-only production recipe. Replace
`@@NODE_IMAGE_DIGEST@@` with one reviewed Node 22.22.3 image digest, stage the matching pinned
Linux Grok 0.2.118 native binary at `build/provider-session/grok/<arch>/grok`, build without pulling
mutable tags, and record only the resulting image digest in the host-private runtime catalog.
Stage Debian Bookworm `bubblewrap_0.8.0-2+deb12u1` as
`build/provider-session/debian/<arch>/bubblewrap.deb`; the recipe rejects anything except the
reviewed Debian SHA-256 values (`arm64` `d044ba1d...e083557`, `amd64` `3cc9134a...aeaadb`).

The image contains no provider credential, engine client configuration, SSH material, or Worker
private root. At runtime the host supervisor supplies only the Workspace, a temporary non-secret
state root, and a session-bound inference transport: a private Unix socket for rootless Podman or
the bounded attach-stdio multiplexer for Docker Desktop/Colima. The image has no entrypoint so the
supervisor's fixed `/opt/agent-deck/bin/provider-session` command remains authoritative.

The Core broker is a bounded transport, not a Chat Completions-only or open HTTP proxy. Each
trusted Provider profile registers an exact `adapterId` / `providerId` / `upstreamId`, HTTPS
path-specific origin, allowed path set, credential injector, and limits. The production `grok-xai`
profile binds exactly `/v1/chat/completions` and `/v1/responses` to their Core-owned xAI origins;
the shim answers only the fixed local `GET /v1/models` catalog required by pinned Grok. Independent
Claude Messages, OpenAI Responses, or other trusted profiles can be added without allowing a
container to choose an origin, inject an authorization header, or reuse a credential.

The production Grok credential input is a Core-only, mode-0600 JSON file with exactly one
top-level `xai::cached` entry. That entry must use `auth_mode: "oauth"`, contain one non-empty
printable-ASCII `key`, and may contain an ISO timestamp `expires_at` that is still in the future:

```json
{
  "xai::cached": {
    "auth_mode": "oauth",
    "key": "REPLACE_WITH_CORE_ONLY_TOKEN",
    "expires_at": "2099-01-01T00:00:00Z"
  }
}
```

Any sibling provider entry, different namespace/auth mode, expired timestamp, or malformed token
fails closed and keeps only Grok unavailable. The file is read by Core on demand and is never
mounted into the Provider container or projected into Worker/provider state.

Run the macOS Colima acceptance gate only against an explicitly provisioned acceptance root and
an immutable, locally built image. The test creates and removes identity-checked children beneath
that root and uses a dummy canary credential; it does not call a real model upstream:

```sh
AGENT_DECK_PROVIDER_LIVE_DOCKER=/absolute/path/to/docker \
AGENT_DECK_PROVIDER_LIVE_DOCKER_HOST=unix:///absolute/path/to/docker.sock \
AGENT_DECK_PROVIDER_LIVE_ROOT=/private/tmp/agent-deck-provider-live \
AGENT_DECK_PROVIDER_LIVE_IMAGE=sha256:<64-hex-image-id> \
AGENT_DECK_PROVIDER_LIVE_WORKSPACE=/absolute/path/to/workspace \
mise exec -- pnpm check:provider-session-live
```

The gate drives real pinned Grok through both exact inference paths and an actual ACP `allow_once`
file-tool decision. It verifies a host-visible Workspace write, a read-only write denial, an
adjacent-root read denial, credential/body non-disclosure, mount hardening, and exact teardown.
This proves the macOS Desktop-VM path only. Rootless Podman still requires its own provisioned-host
acceptance for mounts, UID mapping, Unix-socket reachability, ACP stdio, teardown, and credential
non-disclosure.

## Host supervisor provisioning

The supervisor is a separate host service. It is never started inside Worker bwrap or the Full
Core container, and neither of those processes receives the Docker/Podman socket. The shipped
entrypoint derives only the private runtime namespace; the operator remains responsible for the
exact OCI executable, immutable image digest, Workspace mapping, and service lifecycle.

First derive the same namespace used by Core. `--worker-config` is required for a Relay Worker and
omitted for Full. The Linux Relay result is under `/run/user/<uid>`; the macOS Relay result is under
`/private/tmp`. Full derives the `.provider-<digest>` suffix beneath the supplied socket-volume data
root. A Full host path may exceed the direct Unix-socket bound when its private-root-relative suffix
is portable; the supervisor then uses the identity-pinned directory-fd listener described below.

```bash
/opt/agent-deck/bin/agent-deck-provider-supervisor runtime-paths \
  --instance instance-a \
  --runtime-parent /run/user/1001 \
  --uid 1001 \
  --worker-config worker-config-a
```

Copy the matching example to a service-owned mode-0600 file and replace every illustrative path and
digest. For Docker/Colima, render `executable` from the canonical output of
`realpath "$(command -v docker)"`; the common `/opt/homebrew/bin/docker` symlink is deliberately
rejected by the executable identity fence. Prepare the exact runtime roots and validate the config:

```bash
install -d -m 0700 /run/user/1001/adp-EXACT/{state,broker,supervisor}
install -m 0600 deploy/linux/provider-session/rootless-podman.config.example.json \
  /var/lib/agent-deck/.config/agent-deck/provider-supervisor-instance-a.json
/opt/agent-deck/bin/agent-deck-provider-supervisor prepare-runtime \
  --config /var/lib/agent-deck/.config/agent-deck/provider-supervisor-instance-a.json
/opt/agent-deck/bin/agent-deck-provider-supervisor check-config \
  --config /var/lib/agent-deck/.config/agent-deck/provider-supervisor-instance-a.json
```

`prepare-runtime` creates only the config's private/state/broker/transport directories as the
current service uid with mode 0700 and rejects symlink, owner, or mode substitution. `serve` repeats
that idempotent preparation, so Linux login/reboot and macOS `/private/tmp` cleanup self-heal before
mount/listener construction. `check-config` checks the exact authority shape only. Service startup additionally revalidates
ownership, modes, canonical filesystem identity, the Workspace, OCI executable/socket, rootless or
Desktop-VM readiness, and the pinned image. A mutable tag, missing root, symlink, wrong uid, or
engine mismatch keeps Grok unavailable.

### Linux systemd user service

Render `agent-deck-provider-supervisor.service.in` with the exact instance, config,
and transport socket returned above. Its first `ExecStartPre` recreates the ephemeral roots before
any working-directory or socket dependency. Install it as a user unit and keep it enabled independently
of the Worker/Core container. `Restart=always` makes a clean Core close retire all containers and
then restore an empty supervisor for the next Core generation.

```bash
install -m 0600 /path/to/rendered/agent-deck-provider-supervisor-instance-a.service \
  "$HOME/.config/systemd/user/agent-deck-provider-supervisor-instance-a.service"
systemctl --user daemon-reload
systemctl --user enable --now agent-deck-provider-supervisor-instance-a.service
/opt/agent-deck/bin/agent-deck-provider-supervisor health-config \
  --config /var/lib/agent-deck/.config/agent-deck/provider-supervisor-instance-a.json
```

For Full, use `rootless-podman-full.config.example.json` and resolve the exact rootless Podman
socket/workspace named-volume data paths with `podman volume inspect` under the same service
account. Long physical volume paths are supported without symlinks: the supervisor opens the exact
private-root directory with `O_NOFOLLOW` and binds through `/proc/self/fd`; Core connects to the
same socket inode through its short `/run/agent-deck` named-volume view. Stop and remove the unit
before deleting any Provider runtime directory.

### macOS Relay LaunchAgent

The signed app packages `Agent Deck Worker Node`, the Provider supervisor bundle/wrapper,
`colima.config.example.json`, and `com.agentdeck.provider-supervisor.plist.in`. Use the Worker
configuration id printed by `agent-deck-worker status`, the current uid, and the app-bundled
wrapper to derive the short root:

```bash
SUPERVISOR='/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck-provider-supervisor'
"$SUPERVISOR" runtime-paths \
  --instance instance-a --runtime-parent /private/tmp --uid "$(id -u)" \
  --worker-config worker-config-a
```

Render the Colima config and plist with the exact Docker CLI, Colima socket, immutable local image
id, Workspace, derived paths, and wrapper path. Keep the config and plist mode 0600. Then:

```bash
"$SUPERVISOR" prepare-runtime --config "$HOME/Library/Application Support/Agent Deck/provider-instance-a.json"
"$SUPERVISOR" check-config --config "$HOME/Library/Application Support/Agent Deck/provider-instance-a.json"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.agentdeck.provider-supervisor.instance-a.plist"
"$SUPERVISOR" wait-ready \
  --config "$HOME/Library/Application Support/Agent Deck/provider-instance-a.json" \
  --deadline-ms 120000
"$SUPERVISOR" health-config --config "$HOME/Library/Application Support/Agent Deck/provider-instance-a.json"
```

Stop with `launchctl bootout gui/$(id -u)/com.agentdeck.provider-supervisor.instance-a` before
removing its config or runtime directory. The normal Worker `configure` path opts Core into the
versioned Provider boundary; Grok is published only after this supervisor and the Core-only
inference credential are both ready.
