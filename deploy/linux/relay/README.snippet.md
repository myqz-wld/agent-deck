# Relay-only installation paths

The image and host forced-command service install `/usr/bin/node`, the root-owned non-symlink
bundle `/opt/agent-deck/linux-headless/relay/index.mjs`, and
`/opt/agent-deck/bin/agent-deck-relay`. The wrapper starts Node with a fixed minimal environment;
SSH cannot select a different Node, bundle root, loader option, or `PATH`.

Replace `INSTANCE_ID`, `CREDENTIAL_ID`, `WORKER_ID`, `RUNTIME_UID`, and the public key in the
authorized-key fixtures. Use the exact `desktop-full` line for an Electron SSH credential and the
exact `feishu-session-console` line for a Feishu service credential. `RUNTIME_UID` is the uid of the
same rootless service account that owns
the Relay Quadlet. The forced command binds the exact host control socket under
`/run/user/<uid>/agent-deck-relay/<instance>/control.sock`; the container sees that directory only
through its existing per-instance bind. Relay remains metadata-only and exposes no public port.

The Quadlet overrides any inherited image healthcheck and probes only the private per-instance
control socket through `agent-deck-relay health`. `Notify=healthy` gates systemd startup, an
unhealthy container is killed for bounded systemd restart, and the instance manager still polls
the exact container name, image, running state, and health within its configured total deadline.
