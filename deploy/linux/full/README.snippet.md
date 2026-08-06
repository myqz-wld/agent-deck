# Full Server Core appliance baseline

`agent-deck-full@.container.in` is a parameterized rootless Quadlet input, not an install-ready
unit. Render every `@@...@@` value, keep the image pinned by SHA-256 digest, and install the result
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
`authorized-client-key-options.txt` is the narrow host bridge provisioning fixture. Replace every
identity/key placeholder, choose the exact `desktop-full` or `feishu-session-console` line for that
credential, keep the forced command exact, and run sshd under the same rootless
service account that owns the Full Quadlet. The requested SSH command must be exactly
`agent-deck-bridge`; no host socket pathname is used.

Issue each desktop a separate one-file connection credential on the SSH host. This command creates
an Ed25519 client identity, atomically enrolls its public key in both the live credential authority
and `authorized_keys`, pins the SSH host public key, and writes the only private export as a new
mode-0600 file. It never prints the private key. Use canonical paths owned by the trusted operator;
the output must not already exist:

```bash
umask 077
/opt/agent-deck/bin/agent-deckd issue-connection \
  --instance instance-a \
  --credential desktop-macbook-a \
  --label 'Production' \
  --hostname core.example.com \
  --port 22 \
  --username agentdeck \
  --host-key /etc/ssh/ssh_host_ed25519_key.pub \
  --credential-file /path/to/instance/secrets/credentials.json \
  --authorized-keys /var/lib/agent-deck/.ssh/authorized_keys \
  --output /secure-transfer/production.agentdeck-connection
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
