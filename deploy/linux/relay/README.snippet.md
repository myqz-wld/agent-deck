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

Issue a desktop credential entirely on the Relay host; the desktop does not pre-generate or send a
public key. The command creates an Ed25519 identity, updates the authoritative Relay config and
`authorized_keys`, pins the SSH host public key, and writes one new mode-0600 private connection
file without printing it:

```bash
umask 077
/opt/agent-deck/bin/agent-deck-relay issue-connection \
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
  --output /secure-transfer/production-relay.agentdeck-connection
systemctl --user restart agent-deck-relay@instance-a.service
```

Transfer only the resulting `.agentdeck-connection` file over an authenticated private channel,
import it once, and delete the transfer copy. The restart makes the new authoritative config live;
it does not add Relay compute or a business queue.

The Quadlet overrides any inherited image healthcheck and probes only the private per-instance
control socket through `agent-deck-relay health`. `Notify=healthy` gates systemd startup, an
unhealthy container is killed for bounded systemd restart, and the instance manager still polls
the exact container name, image, running state, and health within its configured total deadline.
