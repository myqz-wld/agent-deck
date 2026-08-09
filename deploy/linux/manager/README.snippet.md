# Linux headless package installation contract

Install Node at the regular non-symlink path `/usr/bin/node`; wrappers also require the package-owned
system paths `/bin/bash`, `/usr/bin/env`, `/usr/bin/readlink`, and `/usr/bin/stat`. Install every Agent Deck wrapper and
single-file bundle as `root:root`, without group/world write permission or symlink components:

- Server Core container: `/opt/agent-deck/bin/agent-deckd` and
  `/opt/agent-deck/linux-headless/server-core/index.mjs`.
- Full host SSH bridge: `/opt/agent-deck/bin/agent-deck-full-bridge` and
  `/opt/agent-deck/linux-headless/server-core-host-bridge/index.mjs`; rootless Podman is
  `/usr/bin/podman` and the service-account home is `/var/lib/agent-deck`.
- Relay image and host forced commands: `/opt/agent-deck/bin/agent-deck-relay` and
  `/opt/agent-deck/linux-headless/relay/index.mjs`.
- Local Worker: `/opt/agent-deck/bin/agent-deck-worker`,
  `/opt/agent-deck/linux-headless/local-worker/index.mjs`, and the concrete Core runtime at
  `/opt/agent-deck/linux-headless/local-worker-runtime/index.mjs`.
- Feishu outbound adapter: `/opt/agent-deck/bin/agent-deck-feishu`,
  `/opt/agent-deck/linux-headless/feishu/index.mjs`, and the installed preflight at
  `/opt/agent-deck/libexec/agent-deck-feishu-preflight`.

`linux-headless.package.json` is the machine-checked copy of this mapping. The wrappers use Bash
privileged mode to ignore startup files, clear loader/Node/development override variables before
any external check, accept no production runtime override, and launch Node through an empty
environment containing only fixed locale/path/home values plus the exact SSH original-command
fence where required. Provisioning must also keep `PermitUserEnvironment no`, must not accept
loader/runtime variables through sshd `AcceptEnv`, and must not add `environment=` key options.

For Full instances, the manager also owns the runtime-config copy inside the existing state named
volume. It resolves that volume through rootless Podman, fences the exact opaque volume identity and
data path, writes mode 0600 atomically, and verifies the generation-record SHA before every start or
cutover. Do not add a host/home config bind or independently provision another config copy.
