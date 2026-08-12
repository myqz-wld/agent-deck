# Relay-only installation paths

## Config-driven deployment

Use `deploy/examples/relay-server.config.example.json` and
`deploy/examples/relay-worker.config.example.json` as the exact starting shapes. Keep the live
copies, SSH private key, Worker connection credential, and runtime config outside the repository.
The server config requires a pinned `known_hosts` file, an immutable digest-pinned Node base image,
the rootless service-account uid, and explicit egress/quota acceptance. The Worker example uses a
dedicated home-directory Workspace and must not point into the Agent Deck repository.

Run the non-mutating checks first, then deploy the server before configuring the Worker:

```bash
pnpm deploy:relay-server -- --config /absolute/path/relay-server.json --check
pnpm deploy:relay-server -- --config /absolute/path/relay-server.json --dry-run
pnpm deploy:relay-server -- --config /absolute/path/relay-server.json --deploy

pnpm deploy:relay-worker -- --config /absolute/path/relay-worker.json --check
pnpm deploy:relay-worker -- --config /absolute/path/relay-worker.json --deploy
pnpm deploy:relay-worker -- --config /absolute/path/relay-worker.json --verify
```

The server script refuses dirty or upstream-diverged source, builds Relay from the exact current
commit, installs root-owned host artifacts, builds the image under the rootless service account,
and records only its immutable digest. `--upgrade` stages the next generation and performs a
health-gated cutover; `--rollback` uses the manager's recoverable previous generation. `--verify`
checks only the existing systemd user unit, exact container, image, and health state and therefore
can also inspect an older unmanaged Relay without adopting it.

The target host must already have the service user at `/var/lib/agent-deck`, Node.js 22 or newer at
`/usr/bin/node`, rootless Podman at `/usr/bin/podman`, cgroup v2, a working systemd user manager,
and non-interactive sudo for the SSH administrator. Enable linger before `--check`; the mutating
install also enables it. The acceptance booleans are not probes: set them only after the 1 GiB
state quota and public-only egress restrictions have independent evidence. The script then writes
the legacy and generation-specific evidence with the exact unit digest expected by the manager.

Worker `--upgrade` revalidates the installed signed runtime and kickstarts the existing
LaunchAgent/systemd-user definition. It does not replace the Agent Deck application. Worker
rollback requires reinstalling the older signed app and running `--upgrade`; there is no fake
generation rollback for local Worker binaries. After the first successful configuration and secure
deletion of the transfer copy, set `credentialFile` to `null`; `--check`, `--upgrade`, and
`--verify` do not require the private transfer credential.

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
  --workspace /srv/workspaces/production \
  --session-catalog /secure-transfer/remote-session-catalog.json
```

`configure` copies the Worker identity into its own mode-0700 private directory, installs one
systemd-user service on Linux or one LaunchAgent on macOS, and starts it. It does not add anything
to the Agent Deck page. Later lifecycle operations remain terminal-only and do not change the
desktop Local/Remote selection:

The optional session catalog is the only source for Remote Gateway/Provider choices. Start from
`deploy/examples/remote-session-catalog.example.json` and replace its placeholder identifiers.
It may contain only allowlisted provider/model identifiers and defaults—never endpoints,
environment values, tokens, auth material, private keys, or provider configuration. The Worker
validates this bounded projection and never opens Claude, Codex, or Grok configuration to discover
the choices. Omit `--session-catalog` to follow each provider's default without advertising a
Gateway/Provider override.

```bash
agent-deck-worker status
agent-deck-worker stop
agent-deck-worker start
# Explicitly stops the service and deletes only this machine's Worker-private configuration.
agent-deck-worker remove
```

Worker configuration also opts Core into the versioned Provider-container readiness gate. To make
Remote Grok available, first prepare the host configuration described in
`deploy/linux/provider-session/README.md` with `rootless-podman.config.example.json` on Linux or
`colima.config.example.json` on macOS. On macOS, fill the optional `providerSupervisor` block from
`deploy/examples/relay-worker.config.example.json`, including the exact Worker config id and a
mode-0600 Grok credential. `deploy:relay-worker --check` validates the credential, runtime paths,
and packaged supervisor; the underlying explicit diagnostic is
`agent-deck-provider-supervisor runtime-paths`. `--deploy` or `--upgrade` atomically projects the credential into the
Worker-private root, installs the shipped LaunchAgent, waits for readiness, and restarts that exact
Worker through `agent-deck-worker install-provider-credential` and
`agent-deck-provider-supervisor prepare-runtime`; `--verify` reports Worker service health and the
optional Provider supervisor configuration, credential and service as separate components through
`agent-deck-provider-supervisor health-config`. An expired optional Grok credential degrades only
the Provider component; it is not reported as a generic Worker transport failure. Startup
idempotently recreates the exact mode-0700
runtime hierarchy after macOS temporary-directory cleanup. For Colima, render the canonical
non-symlink result of `realpath "$(command -v docker)"`; Homebrew's bin symlink is rejected. The
supervisor and Worker share only that private runtime root and the selected Workspace. Worker/Core
receives no OCI engine socket, while the container receives no Worker private root, SSH identity,
or reusable provider credential. Linux keeps the documented systemd-user supervisor lifecycle;
the Worker deployment block currently rejects non-macOS hosts. Omitting the block keeps Remote Grok
fail-closed without affecting Claude or Codex.

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
