# Relay-only installation paths

The image materializes and verifies a root-owned, non-symlink `/usr/bin/node`; the image and host
forced-command service also install the root-owned non-symlink bundle
`/opt/agent-deck/linux-headless/relay/index.mjs` and
`/opt/agent-deck/bin/agent-deck-relay`. Install the root-owned mode-0755 host startup gate at
`/opt/agent-deck/bin/agent-deck-relay-health-gate`. The wrapper starts Node with a fixed minimal
environment; SSH cannot select a different Node, bundle root, loader option, or `PATH`.

Each Local Worker installs `/opt/agent-deck/bin/agent-deck-worker`,
`/opt/agent-deck/linux-headless/local-worker/index.mjs`, and the packaged concrete runtime
`/opt/agent-deck/linux-headless/local-worker-runtime/index.mjs`. The Worker owns Core, SQLite,
repositories, and provider processes; Relay never imports that runtime or executes business work.
Linux Worker machines also install root-owned `/usr/bin/bwrap`, and the terminal service starts the
complete Worker/Core/provider tree inside that namespace before constructing a provider. macOS
packages a signed bookmark validator and fixed signed Worker/provider executables. The current
macOS path treats Worker/Core as a trusted broker and applies the filesystem ceiling at each
model-facing provider boundary; it does not claim that the trusted Worker/Core process itself is
confined by App Sandbox. Provider sandbox choices may narrow Workspace access but cannot grant a
model-facing tool access to host or Worker-private paths. `sandbox-exec` is used only by the local
boundary canary and is not represented as the shipped production mechanism.

Replace `INSTANCE_ID`, `CREDENTIAL_ID`, `WORKER_ID`, `RUNTIME_UID`, and the public key in the
authorized-key fixtures. Use the exact `desktop-full` line for an Electron SSH credential and the
exact `feishu-session-console` line for a Feishu service credential. `RUNTIME_UID` is the uid of the
same rootless service account that owns
the Relay Quadlet. The forced command binds the exact host control socket under
`/run/user/<uid>/agent-deck-relay/<instance>/control.sock`; the container sees that directory only
through its existing per-instance bind. Relay remains metadata-only and exposes no public port.

Issue credentials entirely on the Relay host; neither the Worker nor a desktop pre-generates and
returns a public key. First create the one Worker credential for the designated Mac/Linux Worker.
The command binds its public key only to the `attach` forced command and writes one new mode-0600
private transfer file without printing it:

```bash
umask 077
/opt/agent-deck/bin/agent-deck-relay issue-worker-connection \
  --instance instance-a \
  --credential worker-credential-macbook-a \
  --worker worker-macbook-a \
  --label 'Production relay worker' \
  --hostname relay.example.com \
  --port 22 \
  --username agentdeck \
  --host-key /etc/ssh/ssh_host_ed25519_key.pub \
  --config /var/lib/agent-deck/.config/agent-deck-relay/instance-a/config.json \
  --authorized-keys /var/lib/agent-deck/.ssh/authorized_keys \
  --runtime-uid 1001 \
  --output /secure-transfer/production-relay-worker.agentdeck-connection
```

Transfer that file only to the Worker machine and configure it from a terminal with the shared
workspace. Worker configuration is never imported into Electron and is never shown in Remote
settings. Then issue a separate Client credential for each desktop; each public key is bound only
to the `bridge --surface desktop-full` forced command:

```bash
agent-deck-worker configure \
  --credential /secure-transfer/production-relay-worker.agentdeck-connection \
  --workspace /srv/workspaces/production
```

`configure` copies the Worker identity into its own mode-0700 private directory, installs one
systemd-user service on Linux or one LaunchAgent on macOS, and starts it. It does not add anything
to the Agent Deck page. Later lifecycle operations remain terminal-only and do not change the
desktop Local/Remote selection:

```bash
agent-deck-worker status
agent-deck-worker stop
agent-deck-worker start
# Explicitly stops the service and deletes only this machine's Worker-private configuration.
agent-deck-worker remove
```

Worker configuration also opts Core into the versioned Provider-container readiness gate. To make
Remote Grok available, provision the independently managed host supervisor described in
`deploy/linux/provider-session/README.md`: use
`rootless-podman.config.example.json` on Linux or `colima.config.example.json` on macOS, derive the
exact short namespace with `agent-deck-provider-supervisor runtime-paths`, install the shipped
systemd-user unit or LaunchAgent template, and verify it with
`agent-deck-provider-supervisor prepare-runtime` and
`agent-deck-provider-supervisor health-config`. Startup idempotently recreates the exact mode-0700
runtime hierarchy after Linux login/reboot or macOS temporary-directory cleanup. For Colima, render
the canonical non-symlink result of `realpath "$(command -v docker)"`; Homebrew's bin symlink is
rejected. The supervisor and Worker share only that private
runtime root and the selected Workspace. Worker/Core receives no OCI engine socket, while the
container receives no Worker private root, SSH identity, or reusable provider credential.

Removing the local configuration does not revoke the Relay-side credential. Revoke or rotate that
credential separately on the Relay host before transferring a replacement Worker credential.

```bash
umask 077
/opt/agent-deck/bin/agent-deck-relay issue-client-connection \
  --instance instance-a \
  --credential desktop-macbook-a \
  --label 'Production relay' \
  --hostname relay.example.com \
  --port 22 \
  --username agentdeck \
  --host-key /etc/ssh/ssh_host_ed25519_key.pub \
  --config /var/lib/agent-deck/.config/agent-deck-relay/instance-a/config.json \
  --authorized-keys /var/lib/agent-deck/.ssh/authorized_keys \
  --runtime-uid 1001 \
  --output /secure-transfer/production-relay-client.agentdeck-connection
systemctl --user restart agent-deck-relay@instance-a.service
```

Transfer each file only to its intended machine over an authenticated private channel and delete
the transfer copy after terminal configuration or Electron import. One Relay accepts one active
Worker identity and any number of independently revocable Client identities; deploy another
isolated Relay/Worker pair for another tenant or workspace. The restart makes the new authoritative
config live; it does not add Relay compute or a business queue.

The Quadlet overrides any inherited image healthcheck and probes only the private per-instance
control socket through `agent-deck-relay health`. Its Podman JSON argv begins with the executable
itself; Dockerfile's `CMD` marker is not a Podman health-command argument. Native `Notify=healthy`
gates systemd startup on
Podman versions that support healthy sd-notify; the bounded host startup gate enforces the same
wait on older Quadlet generators. An unhealthy container is killed for bounded systemd restart,
and the instance manager still polls
the exact container name, image, running state, and health within its configured total deadline.
Runtime preflight also launches a hardened canary and requires rootless Podman to advance its
health state automatically, which rejects a stale or unavailable user-systemd health scheduler.
Both runtime probes execute the exact `/usr/bin/node` required by the Relay wrapper rather than a
`PATH`-resolved executable.
