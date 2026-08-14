# Full Server Core appliance baseline

## Config-driven deployment

Start from `deploy/examples/full-server.config.example.json` and keep the live config, SSH key,
runtime config, credential authority, and optional provider-auth files outside the repository.
Full has no separate Worker deployment: Server Core, repositories, providers, session state, and
Browser data all live in the appliance.

No hand-maintained Remote session catalog is used. At Server Core startup, the trusted provider
source projection derives one bounded, non-secret Gateway/Provider/model snapshot. Remote
capability requests consume only that snapshot and never open raw provider configuration.
Full keeps its own read-only settings in `runtimeOptions.providerSettings`; it never imports a
desktop or Relay Worker settings snapshot. Built-in Agent model, reasoning, and Claude
Gateway/Codex Provider changes belong in `bundledAgentRuntimeOverrides` there. The same values are
shown in the Remote Assets page and are used when `spawn_session` selects that built-in Agent.

```bash
pnpm deploy:full-server -- --config /absolute/path/full-server.json --check
pnpm deploy:full-server -- --config /absolute/path/full-server.json --dry-run
pnpm deploy:full-server -- --config /absolute/path/full-server.json --deploy
pnpm deploy:full-server -- --config /absolute/path/full-server.json --upgrade
pnpm deploy:full-server -- --config /absolute/path/full-server.json --rollback
pnpm deploy:full-server -- --config /absolute/path/full-server.json --verify
```

The script uses the exact clean, upstream-aligned Git commit for host artifacts, but it does not
build the Full appliance image. `image.reference` must name a separately built image pinned by one
SHA-256 digest and corresponding to that source release. Before `--check`, provision the
rootless service user at `/var/lib/agent-deck`, Node.js 22 or newer, rootless Podman, cgroup v2,
systemd-user linger, non-interactive sudo for the SSH administrator, and the independently tested
`agent-deck-<instance>-egress` network.

On first deploy, the manager creates the exact named volumes and the script initializes only the
allowlisted secrets paths from `secrets.credentialsFile` plus the optional Claude, Codex, and Grok
auth inputs. Secret file contents never enter argv or logs. Later image upgrades and rollbacks do
not rewrite the secrets volume; rotate live credential authority and provider auth through the
separate trusted-operator procedure below.

`--upgrade` and `--rollback` use expected generation/version fences and require a healthy running
instance. `--verify` is read-only and can inspect an unmanaged Full container without adopting it.
Lifecycle actions do not silently migrate an unmanaged installation. The acceptance booleans are
operator attestations, not enforcement: set them only after the named egress gateway and every
state/workspace/browser quota have been independently tested. The script binds the resulting
evidence to the exact instance, generation, image, rendered unit digest, and resource limits.

Remote Grok remains optional. The Full script can seed its Core-side `grok-auth.json` input, but it
does not provision the external Provider supervisor, its image, or its dedicated lifecycle. Use
the provider-session contract below only when Remote Grok is required.

`agent-deck-full@.container.in` is a parameterized rootless Quadlet input, not an install-ready
unit. Render every declared placeholder, keep the image pinned by SHA-256 digest, and install the result
in a rootless Quadlet search path such as `$XDG_CONFIG_HOME/containers/systemd/`.

The unit deliberately has no `PublishPort`, `AddDevice`, host/root/home bind, or container-engine
socket. Its image is read-only; mutable state, workspaces, the private daemon socket, Browser data,
and secrets use separate instance-namespaced volumes. The state/workspace/browser volumes require
a host-tested quota backend before the `volume-quota.verified` gate may be created. The socket is
private at `/run/agent-deck/<instanceId>/agent-deckd.sock` inside the socket named volume. The
host SSH forced command never treats that as a host pathname. It verifies rootless Podman, the
exact running `agent-deck-full-<instanceId>` container id and its instance/topology/manager labels,
then runs argv-only `podman exec -i <container-id> /opt/agent-deck/bin/agent-deckd
bridge-internal ...`; only stdin/stdout cross this boundary. There is no public control listener,
engine-socket mount, or broad host bind.

Important network boundary: an ordinary rootless Podman bridge is namespace isolation, not proof
of destination-based egress enforcement. `@@VERIFIED_EGRESS_NETWORK@@` must name a deployment-owned
network/gateway that has been tested to allow public DNS and HTTP(S) while denying inbound access,
host loopback, RFC1918/LAN ranges, IPv6 local/private ranges, and cloud metadata endpoints. Until
that exists, do not create `egress-policy.verified`; the unit then fails closed at `ExecStartPre`.

The image must install root-owned, non-symlink
`/opt/agent-deck/linux-headless/server-core/index.mjs`,
`/opt/agent-deck/linux-headless/server-core-runtime/index.mjs`,
`/opt/agent-deck/bin/agent-deckd`, `/usr/bin/node`, and the executable provider payloads at
`/opt/agent-deck/providers/{claude/claude,codex/codex,grok/grok}`. The rootless host service
account has the fixed home `/var/lib/agent-deck` and
must install root-owned `/opt/agent-deck/linux-headless/server-core-host-bridge/index.mjs` plus
`/opt/agent-deck/bin/agent-deck-full-bridge`; the host bridge uses `/usr/bin/node` and
`/usr/bin/podman` only. The package mapping is locked by
`deploy/linux/manager/linux-headless.package.json`.
The host-only instance manager owns the exact mode-0600 instance config consumed at
`/var/lib/agent-deck/config/agent-deck/instances/<instanceId>/config.json` inside the instance state
volume. Create, upgrade, rollback, start, and crash recovery re-resolve the exact rootless Podman
state-volume identity and data path, atomically install the canonical config, and verify its SHA-256
against the generation record before starting the container. Provisioning must not seed a separate
copy or add a host/home bind; the existing instance-namespaced named volume remains the only runtime
mount. The config binds its instance id and private socket path; it names a separately packaged,
trusted Node runtime module that owns Core, repositories, providers, SQLite, and provider execution.
The packaged runtime reads its live credential authority only from the canonical, mode-0600
`/run/secrets/agent-deck/credentials.json` file in the read-only secrets volume. Seed it from
`server-core.credentials.example.json` with the exact instance id, credential id, surface, and
status used by each forced key. Removing an active record, changing it to `revoked`, or making the
authority unreadable closes only the matching live connections; an invalid authority fails closed.
Updates must be atomically published into the instance-namespaced secrets volume by the trusted
operator. They are not accepted from SSH input, provider payloads, environment variables, or the
renderer.

Provider authentication and session configuration use exact projections within that same
read-only secrets volume. The optional source root `/run/secrets/agent-deck/provider-home` may
contain `.claude/.credentials.json`, `.claude/settings.json`, regular
`.claude/gateways/*.json` profiles, `.codex/auth.json`, `.codex/config.toml`, and
`.grok/config.toml`. The separate Core-only broker root
`/run/secrets/agent-deck/provider-inference` may contain only its mode-0600 `grok-auth.json` input.
The source roots and provider subdirectories must be service-owned mode 0700; files must be mode
0600. At Server Core startup credentials, sanitized Claude Gateway runtime files, sanitized Codex
provider definitions, and the derived non-secret capability snapshot are atomically refreshed into
the instance-private provider home. Original Claude/Grok settings are used only to derive safe
defaults and are not copied. An allowlisted destination whose source was removed is deleted; a
retired provider-home `.grok/auth.json` destination is also deleted and is never projected.

Remote Grok is published as available only when the exact `providerContainer` opt-in, the external
host-owned Provider supervisor, its digest-pinned Grok image, and the Core inference credential are
all ready. The Provider container gets no engine socket or credential: Full maps the
instance-namespaced socket and Workspace volumes to the independently managed supervisor, while
Core injects the credential only into the fixed trusted upstream request. If any readiness check
fails, only the Grok choices fail closed with a Core-owned reason; Claude and Codex remain usable.
Hooks, MCP definitions, plugins, global instructions, SSH files, and the rest of an operator home
are never projected. Restart the instance after publishing provider auth or configuration changes.
Provider processes receive the exact private HOME, while model-facing sandbox roots deny that
provider home and the whole state volume.

Provision that external lifecycle with the shipped
`deploy/linux/provider-session/agent-deck-provider-supervisor.service.in` and
`rootless-podman-full.config.example.json`. Resolve the exact rootless socket/workspace volume data
paths with `podman volume inspect`, render every unit/config placeholder, keep the config mode 0600
and every Provider runtime directory mode 0700, then install the unit under the same rootless
service account. Its `prepare-runtime` preflight recreates only the exact mode-0700 hierarchy after
the host runtime directory is absent. The unit uses `wait-ready --config` during startup; verify it independently with
`agent-deck-provider-supervisor health-config --config <exact-config>`. A long physical Podman
volume path is bound through an identity-pinned directory fd to the same inode Core sees through
the short named-volume path; no symlink or engine-socket projection is used. Static packaging only
proves this lifecycle is declared and parseable. Rootless-Podman/Full live acceptance remains a
real Linux host gate.
`authorized-client-key-options.txt` is the narrow host bridge provisioning fixture. Replace every
identity/key placeholder, choose the exact `desktop` or `feishu` line for that
credential, keep the forced command exact, and run sshd under the same rootless
service account that owns the Full Quadlet. The requested SSH command must be exactly
`agent-deck-bridge`; no host socket pathname is used.

Issue each desktop a separate one-file connection credential through the root-only Server control
CLI on the SSH host. Render `server-control.config.example.json` to the root-owned mode-0600
`/etc/agent-deck/server-control/instance-a.json`, and render
`connection-issue.request.example.json` to another root-owned mode-0600 request. The command creates
an Ed25519 client identity, atomically enrolls its public key in both the live credential authority
and `authorized_keys`, pins the SSH host public key, and writes the only private export as a new
mode-0600 file. It never prints the private key. Use canonical paths owned by the trusted operator;
the output must not already exist:

```bash
umask 077
/opt/agent-deck/bin/agent-deck-server connections issue \
  --config /etc/agent-deck/server-control/instance-a.json \
  --request /etc/agent-deck/server-control/issue-desktop-a.json
/opt/agent-deck/bin/agent-deck-server connections verify \
  --config /etc/agent-deck/server-control/instance-a.json
```

Transfer that single `.agentdeck-connection` file to the desktop over an authenticated private
channel, import it in Agent Deck, then delete the transfer copy. Do not reuse one credential across
devices; revocation remains exact per credential id and desktop surface.

Static checks:

```bash
bash -n deploy/linux/full/preflight.sh
bash deploy/linux/full/static-check.sh
bash deploy/linux/full/preflight.sh --template \
  deploy/linux/full/agent-deck-full@.container.in
```

After rendering, run `--rendered`. On a real Ubuntu 24.04 or EL9 host, run `--host` only after the
egress gateway and volume quotas have independent evidence:

```bash
AGENT_DECK_EGRESS_ENFORCEMENT=verified-egress-gateway \
AGENT_DECK_VOLUME_QUOTA_READY=verified \
bash deploy/linux/full/preflight.sh --host /path/to/agent-deck-full@.container
```

The host check verifies Linux, rootless Podman, cgroup v2, subordinate UID/GID ranges, the static
unit constraints, and the two explicit gates. It does not claim Ubuntu/EL9, SELinux/AppArmor,
nested provider sandbox, egress, quota, health, upgrade, backup, or rollback acceptance merely from
macOS/static execution. Those remain real-host gates.

The packaged image should also be checked with `agent-deckd check-abi`; that command loads the
Node-native `better-sqlite3` binding and opens only an in-memory probe, failing before production
state is touched when the Node ABI is wrong.
