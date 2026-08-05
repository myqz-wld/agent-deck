# Feishu outbound adapter deployment

One service binds one exact Agent Deck instance, topology, Feishu app, and tenant. It opens an
authenticated outbound Feishu WebSocket plus outbound HTTPS calls and reaches the same authoritative
Core as desktop clients through a second, restricted outbound OpenSSH connection. It has no callback
listener, public Agent Deck port, direct Core socket, local compute fallback, or Relay offline
business queue.

The Feishu process uses `/opt/agent-deck/bin/agent-deck-feishu`; the root-owned single-file bundle is
`/opt/agent-deck/linux-headless/feishu/index.mjs`. `core-ssh.json` pins the topology, instance,
hostname, host key file, and one private identity per active owner-equivalent Feishu credential. The
server-side public key must use the `feishu-session-console` forced-command line from the matching
Full or Relay `authorized-client-key-options.txt`. That surface cannot become an interactive shell,
request a PTY, forward ports/agents/X11, or invoke desktop-only Core methods.

## Provisioning

1. Build and check the isolated artifacts with `pnpm verify:linux-headless`. Install the Feishu
   bundle and wrapper from `deploy/linux/manager/linux-headless.package.json`, plus `preflight.sh`
   as `/opt/agent-deck/libexec/agent-deck-feishu-preflight`, all root-owned and non-writable by the
   service account. The target Node 22 installation must provide `better-sqlite3` for its exact ABI.
2. Create the service account and directories using the `.sysusers` and `.tmpfiles` templates.
   Install `config.json`, `core-ssh.json`, `app-secret`, `action-secret`, pinned `known_hosts`, and
   each SSH private key under `/etc/agent-deck-feishu`. Files are service-owned mode `0600`; the
   directory is root-owned, group `agent-deck-feishu`, mode `0750`; state is service-owned `0700`.
3. Replace every example binding. The active credential-id set in `config.json` must exactly equal
   the identity mapping in `core-ssh.json`, and each corresponding server public key must be enrolled
   as kind `feishu`. Use an independent action MAC secret of at least 32 bytes; never place secrets or
   private key bodies in JSON, environment variables, logs, cards, or metadata.
4. Configure the Feishu app for long-connection delivery, subscribe to `im.message.receive_v1`, and
   register `card.action.trigger`. Grant only the bot receive/send/card permissions used here.
5. Enforce outbound DNS, TCP 443 to Feishu Open Platform, and SSH to the configured Core host while
   denying unsolicited ingress. The systemd unit intentionally has no listener or socket unit.
6. Run the preflight and both executable checks, then enable the unit:

   ```bash
   /opt/agent-deck/libexec/agent-deck-feishu-preflight \
     /etc/agent-deck-feishu/config.json /etc/agent-deck-feishu/core-ssh.json
   /opt/agent-deck/bin/agent-deck-feishu check-abi
   /opt/agent-deck/bin/agent-deck-feishu check-config \
     --config /etc/agent-deck-feishu/config.json \
     --core-ssh-config /etc/agent-deck-feishu/core-ssh.json
   ```

Credential enrollment binds exact `(appId, tenantKey, openId)` subjects to Core credential ids.
Revocation is rechecked for every callback and transport attempt. Approval cards default to 30
minutes; `pendingPresentationLifetimeMs: 0` explicitly makes presentation lifetime indefinite, but
authoritative Core pending state still decides whether an action is valid. SQLite persists only
identity, subscription, cursor, health, and delivery-reconciliation metadata—never message text,
cards, action values, history, diffs, blobs, secrets, paths, or Core frames.

## Delivery and group-chat behavior

Feishu's provider UUID guarantee for message create/reply is exactly one hour. The adapter records
that deadline at the first possibly accepted invocation and never extends it after another ambiguous
try. A crash replay may reuse the UUID only before the recorded deadline. At or after the deadline,
the delivery becomes terminal `exhausted` and is not sent again.

For Core notification streams, terminal `exhausted` means “consumed but deliberately skipped.” The
adapter emits the fixed `delivery_exhausted` / `core-notification-skip` audit and observer records,
advances the durable cursor through that Core revision, and continues with the next revision. A
reconciliation-required notification is first fenced to `exhausted` and follows the same rule.
Repeated exhausted reads do not refresh their retention timestamp. Removing old terminal delivery
rows cannot replay their provider work because the independent monotonic Core cursor remains ahead;
pending and reconciling evidence is never pruned.

Group chats are intentionally read-restricted. `/sessions`, `/projects`, `/history`, and `/runtime`
return fixed prompts without calling the corresponding sensitive Core read. `/pending` exposes only
an owned request-kind projection with no action buttons or arbitrary Core display fields. Use a full
authenticated client or an owner p2p chat for those details and actions.

The repository checks are deterministic and static. Production acceptance still requires real
Ubuntu 24.04/EL9, systemd, target-ABI SQLite, sshd forced commands, pinned host-key failure,
credentialed Feishu readiness/reconnect/send/action flows, revocation, multi-chat load, and the
deployment's egress policy. In particular, static tests do not prove the live provider's one-hour
UUID behavior, WebSocket redelivery ordering, group-card visibility, or post-crash reconciliation;
capture those with disposable credentials before production acceptance.
