# Full Server Core appliance baseline

`agent-deck-full@.container.in` is a parameterized rootless Quadlet input, not an install-ready
unit. Render every `@@...@@` value, keep the image pinned by SHA-256 digest, and install the result
in a rootless Quadlet search path such as `$XDG_CONFIG_HOME/containers/systemd/`.

The unit deliberately has no `PublishPort`, `AddDevice`, host/root/home bind, or container-engine
socket. Its image is read-only; mutable state, workspaces, the private daemon socket, Browser data,
and secrets use separate instance-namespaced volumes. The state/workspace/browser volumes require
a host-tested quota backend before the `volume-quota.verified` gate may be created. The socket is
private at `/run/agent-deck/<instanceId>/agent-deckd.sock`; SSH and gateway bridge processes must reach it through
an explicitly provisioned narrow path rather than a public control listener.

Important network boundary: an ordinary rootless Podman bridge is namespace isolation, not proof
of destination-based egress enforcement. `@@VERIFIED_EGRESS_NETWORK@@` must name a deployment-owned
network/gateway that has been tested to allow public DNS and HTTP(S) while denying inbound access,
host loopback, RFC1918/LAN ranges, IPv6 local/private ranges, and cloud metadata endpoints. Until
that exists, do not create `egress-policy.verified`; the unit then fails closed at `ExecStartPre`.

Static checks:

```bash
bash -n deploy/linux/full/preflight.sh
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
