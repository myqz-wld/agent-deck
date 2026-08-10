#!/usr/bin/env bash
set -euo pipefail

relay_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash -n "$relay_dir/preflight.sh"
bash -n "$relay_dir/static-check.sh"
bash "$relay_dir/preflight.sh" \
  --quadlet "$relay_dir/agent-deck-relay@.container" \
  --static-only

instantiated_fixture="$(mktemp -d)/agent-deck-relay@static-check.container"
cleanup_instantiated_fixture() {
  rm -rf -- "$(dirname "$instantiated_fixture")"
}
trap cleanup_instantiated_fixture EXIT
cp "$relay_dir/agent-deck-relay@.container" "$instantiated_fixture"
bash "$relay_dir/preflight.sh" \
  --quadlet "$instantiated_fixture" \
  --instance static-check \
  --static-only
cleanup_instantiated_fixture
trap - EXIT

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  if (manifest.topology !== "relay" || manifest.rootless !== true) process.exit(1);
  if (!Array.isArray(manifest.publishedPorts) || manifest.publishedPorts.length !== 0) process.exit(1);
  if (manifest.quadletTemplate !== "agent-deck-relay@.container") process.exit(1);
  if (manifest.instanceSpecifier !== "%i" || manifest.engineSocketMounted !== false) process.exit(1);
  if (JSON.stringify(manifest.entrypoint) !== JSON.stringify(["/opt/agent-deck/bin/agent-deck-relay"])) process.exit(1);
  if (manifest.instanceTokenPattern !== "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$") process.exit(1);
  if (manifest.nodeExecutable !== "/usr/bin/node") process.exit(1);
  if (manifest.bundle !== "/opt/agent-deck/linux-headless/relay/index.mjs") process.exit(1);
  if (manifest.hostForcedCommand !== "/opt/agent-deck/bin/agent-deck-relay") process.exit(1);
  if (manifest.runtimeUserTemplate !== "%U:%G" || manifest.userNamespace !== "keep-id") process.exit(1);
  if (manifest.resourceLimits.pids !== 256 || manifest.resourceLimits.memory !== "512M") process.exit(1);
  const gate = manifest.egressAcceptanceGate;
  if (!gate.requiredForProductionStart || gate.defaultStatus !== "unverified") process.exit(1);
  if (gate.slirp4netnsIsEnforcementProof !== false) process.exit(1);
  const quota = manifest.stateVolumeQuotaAcceptanceGate;
  if (!quota.requiredForProductionStart || quota.defaultStatus !== "unverified") process.exit(1);
  if (quota.quadletTemplateIsEnforcementProof !== false) process.exit(1);
  if (quota.maximumBytes !== 1073741824) process.exit(1);
  const identity = manifest.runtimeIdentityAcceptanceGate;
  if (!identity.requiredForProductionStart || identity.defaultStatus !== "unverified") process.exit(1);
  if (identity.quadletTemplateIsEnforcementProof !== false) process.exit(1);
  const scheduler = manifest.healthSchedulerAcceptanceGate;
  if (!scheduler.requiredForProductionStart || scheduler.defaultStatus !== "unverified") process.exit(1);
  if (scheduler.quadletTemplateIsEnforcementProof !== false || scheduler.timeoutSeconds !== 20) process.exit(1);
  const control = manifest.controlSocket;
  if (control.hostSocketTemplate !== "%t/agent-deck-relay/%i/control.sock") process.exit(1);
  if (control.containerSocketTemplate !== "/run/agent-deck-relay/%i/control.sock") process.exit(1);
  if (control.socketMode !== "0600" || control.publicPortFallback !== false) process.exit(1);
  const evidence = manifest.evidenceStorage;
  if (evidence.pathTemplate !== "/etc/agent-deck-relay/evidence/%i") process.exit(1);
  if (evidence.owner !== "root" || evidence.relayServiceWritable !== false) process.exit(1);
  if (manifest.configAcceptanceGate.containerReadOnly !== true) process.exit(1);
  const health = manifest.healthContract;
  if (JSON.stringify(health.command) !== JSON.stringify(["/opt/agent-deck/bin/agent-deck-relay", "health", "--socket", "/run/agent-deck-relay/%i/control.sock"])) process.exit(1);
  if (health.intervalSeconds !== 10 || health.timeoutSeconds !== 3 || health.retries !== 3 || health.startPeriodSeconds !== 30) process.exit(1);
  if (health.onFailure !== "kill" || health.systemdNotify !== "healthy" || health.inheritedImageHealthDisabled !== true) process.exit(1);
  if (health.hostStartupGate !== "/opt/agent-deck/bin/agent-deck-relay-health-gate" || health.hostStartupGateTimeoutSeconds !== 100) process.exit(1);
  if (!manifest.excludedComponents.includes("server compute fallback")) process.exit(1);
' "$relay_dir/relay-only.manifest.json"

fixture_dir="$(mktemp -d)"
cleanup_fixture() {
  rm -rf -- "$fixture_dir"
}
trap cleanup_fixture EXIT
fixture_number=0
for injected in \
  'Volume=/:/host-root:rw' \
  'Device=/dev/kvm' \
  'AddCapability=all' \
  'PublishPort=22:22' \
  'Network=host' \
  'ReadOnly=false' \
  'NoNewPrivileges=false' \
  'PodmanArgs=--privileged'; do
  fixture_number=$((fixture_number + 1))
  fixture="$fixture_dir/tamper-$fixture_number@.container"
  awk -v injected="$injected" '{ print; if ($0 == "[Container]") print injected }' \
    "$relay_dir/agent-deck-relay@.container" > "$fixture"
  if bash "$relay_dir/preflight.sh" --quadlet "$fixture" --static-only >/dev/null 2>&1; then
    echo "relay static check: tampered Quadlet was accepted: $injected" >&2
    exit 1
  fi
done

for replacement in \
  'Network=slirp4netns:allow_host_loopback=false|Network=host' \
  'NoNewPrivileges=true|NoNewPrivileges=false' \
  'ReadOnly=true|ReadOnly=false' \
  'User=%U:%G|User=0:0' \
  'UserNS=keep-id|UserNS=host' \
  'HealthCmd=["/opt/agent-deck/bin/agent-deck-relay","health","--socket","/run/agent-deck-relay/%i/control.sock"]|HealthCmd=["/bin/true"]' \
  'HealthOnFailure=kill|HealthOnFailure=none' \
  'Notify=healthy|Notify=true' \
  'ExecStartPost=/opt/agent-deck/bin/agent-deck-relay-health-gate --container agent-deck-relay-%i|ExecStartPost=/bin/true' \
  'Volume=%h/.local/share/agent-deck-relay/%i:/var/lib/agent-deck-relay/%i:Z|Volume=/:/var/lib/agent-deck-relay/%i:Z' \
  'PodmanArgs=--pids-limit=256 --memory=512m --cpus=1.0|PodmanArgs=--privileged'; do
  fixture_number=$((fixture_number + 1))
  original="${replacement%%|*}"
  tampered="${replacement#*|}"
  fixture="$fixture_dir/replaced-$fixture_number@.container"
  awk -v original="$original" -v tampered="$tampered" \
    '{ print ($0 == original ? tampered : $0) }' \
    "$relay_dir/agent-deck-relay@.container" > "$fixture"
  if bash "$relay_dir/preflight.sh" --quadlet "$fixture" --static-only >/dev/null 2>&1; then
    echo "relay static check: replaced Quadlet setting was accepted: $tampered" >&2
    exit 1
  fi
done

health_gate="$relay_dir/../../../resources/bin/agent-deck-relay-health-gate"
bash -n "$health_gate"
for required in \
  '#!/bin/bash -p' \
  'PATH=/usr/bin:/bin' \
  'deadline=$((SECONDS + 100))' \
  '/usr/bin/podman inspect --type container' \
  "'{{.State.Health.Status}}'" \
  'healthy) exit 0' \
  'unhealthy) fail'; do
  grep -Fq -- "$required" "$health_gate" || {
    echo "relay static check: host health gate lost $required" >&2
    exit 1
  }
done
grep -Fq 'podman_executable='"'"'/usr/bin/podman'"'"'' "$relay_dir/preflight.sh" || {
  echo 'relay static check: runtime preflight must use the packaged Podman path' >&2
  exit 1
}
for required in \
  'health_probe_name="agent-deck-relay-preflight-$runtime_uid-$$"' \
  '--network=slirp4netns:allow_host_loopback=false' \
  '--health-cmd=/usr/bin/true' \
  '--health-interval=1s' \
  '--entrypoint=/usr/bin/node' \
  'timeout 20s "$health_gate" --container "$health_probe_name"' \
  "'{{.State.Health.Status}}'"; do
  grep -Fq -- "$required" "$relay_dir/preflight.sh" || {
    echo "relay static check: runtime preflight lost health scheduler probe: $required" >&2
    exit 1
  }
done
if grep -Eq '(command -v|eval|/bin/sh|-c[[:space:]])' "$health_gate"; then
  echo 'relay static check: host health gate must remain fixed-command only' >&2
  exit 1
fi
cleanup_fixture
trap - EXIT

if ! grep -Eq '^restrict,command="[^"]+",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-' \
  "$relay_dir/authorized-key-options.txt"; then
  echo "relay static check: Worker public key must force attach and disable SSH expansion" >&2
  exit 1
fi
grep -Fq 'command="/opt/agent-deck/bin/agent-deck-relay attach --instance INSTANCE_ID --credential CREDENTIAL_ID --socket /run/user/RUNTIME_UID/agent-deck-relay/INSTANCE_ID/control.sock --worker WORKER_ID"' \
  "$relay_dir/authorized-key-options.txt" || {
  echo "relay static check: Worker forced command must bind instance, credential, and Worker" >&2
  exit 1
}
for surface in desktop-full feishu-session-console; do
  if ! grep -Eq "^restrict,command=\"/opt/agent-deck/bin/agent-deck-relay bridge --instance INSTANCE_ID --credential CREDENTIAL_ID --surface $surface --socket /run/user/RUNTIME_UID/agent-deck-relay/INSTANCE_ID/control.sock\",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-" \
    "$relay_dir/authorized-client-key-options.txt"; then
    echo "relay static check: client key must bind instance, credential, and $surface" >&2
    exit 1
  fi
done
node - "$relay_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const relayDir = process.argv[2];
const source = fs.readFileSync(path.resolve(relayDir, '../../../src/hosts/relay/entrypoint-command.ts'), 'utf8');
function schema(name) {
  const match = new RegExp(`${name}: Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
  if (!match) throw new Error(`missing ${name} production schema`);
  return [...match[1].matchAll(/'(--[^']+)'/g)].map((entry) => entry[1]);
}
const expected = {
  attach: ['--instance', '--credential', '--socket', '--worker'],
  bridge: ['--instance', '--credential', '--surface', '--socket'],
};
for (const [name, flags] of Object.entries(expected)) {
  if (JSON.stringify(schema(name)) !== JSON.stringify(flags)) {
    throw new Error(`${name} production schema drifted from packaged forced commands`);
  }
}
NODE
if grep -Fq 'environment=' "$relay_dir/authorized-key-options.txt" \
  "$relay_dir/authorized-client-key-options.txt"; then
  echo "relay static check: authorized keys must not add inherited environment options" >&2
  exit 1
fi

for required in \
  'agent-deck-relay issue-worker-connection' \
  'agent-deck-relay issue-client-connection' \
  'agent-deck-worker configure' \
  'agent-deck-worker status' \
  'agent-deck-worker stop' \
  'agent-deck-worker start' \
  'agent-deck-worker remove' \
  'agent-deck-provider-supervisor' \
  'runtime-paths' \
  'health-config' \
  'prepare-runtime' \
  'rootless-podman.config.example.json' \
  'colima.config.example.json' \
  '--runtime-uid 1001' \
  '--worker worker-macbook-a' \
  '--host-key /etc/ssh/ssh_host_ed25519_key.pub' \
  '.agentdeck-connection'; do
  grep -Fq -- "$required" "$relay_dir/README.snippet.md" || {
    echo "relay static check: connection credential issuance documentation lost $required" >&2
    exit 1
  }
done
for required in \
  '/usr/bin/bwrap' \
  'com.agentdeck.worker-sandbox' \
  'agent-deck-worker-bookmark' \
  'Agent Deck Worker Node' \
  'prepare-provider-runtime' \
  'prepare_sandboxed_node_environment'; do
  grep -Fq -- "$required" "$relay_dir/../../../resources/bin/agent-deck-worker" || {
    echo "relay static check: Worker outer sandbox wrapper lost $required" >&2
    exit 1
  }
done
for required in \
  'buildDarwinWorkspaceSandboxLaunch' \
  'buildLinuxWorkspaceSandboxLaunch' \
  "'--unshare-all'" \
  "'--clearenv'"; do
  grep -Fq -- "$required" "$relay_dir/../../../src/hosts/workspace-sandbox/launch-policy.ts" || {
    echo "relay static check: Worker launch policy lost $required" >&2
    exit 1
  }
done
grep -Fq '/opt/agent-deck/linux-headless/local-worker-runtime/index.mjs' \
  "$relay_dir/local-worker.config.example.json" "$relay_dir/README.snippet.md" || {
  echo 'relay static check: Local Worker concrete runtime packaging is incomplete' >&2
  exit 1
}
grep -Fq '"providerContainer"' "$relay_dir/local-worker.config.example.json" || {
  echo 'relay static check: Local Worker does not opt into readiness-gated Provider containers' >&2
  exit 1
}
for required in \
  '"schemaVersion": 2' \
  '"workspaceSandbox"' \
  '"execution": "relay-worker"' \
  '"workspaceRoot": "/srv/workspaces/production"' \
  '"privateRoot": "/var/lib/agent-deck/workers/worker-config-a"' \
  '"networkBoundary": "provider-controlled"'; do
  grep -Fq -- "$required" "$relay_dir/local-worker.config.example.json" || {
    echo "relay static check: Local Worker v2 Workspace example lost $required" >&2
    exit 1
  }
done
grep -Fq "if (command === 'issue-client-connection')" \
  "$relay_dir/../../../src/hosts/relay/entrypoint.ts" || {
  echo 'relay static check: Relay entrypoint lost one-shot Client issuance' >&2
  exit 1
}
grep -Fq "if (command === 'issue-worker-connection')" \
  "$relay_dir/../../../src/hosts/relay/entrypoint.ts" || {
  echo 'relay static check: Relay entrypoint lost one-shot Worker issuance' >&2
  exit 1
}

if grep -Eqi '(@openai/codex|claude-agent-sdk|xai-official|chrom(e|ium)|better-sqlite3|git[[:space:]]+workspace)' \
  "$relay_dir/Containerfile" "$relay_dir/agent-deck-relay@.container"; then
  echo "relay static check: forbidden full-Core build content found" >&2
  exit 1
fi

grep -Fqx 'COPY build/linux-headless/relay/ /opt/agent-deck/linux-headless/relay/' "$relay_dir/Containerfile" || {
  echo "relay static check: image must copy only the isolated Relay headless artifact" >&2
  exit 1
}
for required in \
  'test -f /usr/local/bin/node' \
  'test ! -L /usr/local/bin/node' \
  'ln /usr/local/bin/node /usr/bin/node' \
  'test -f /usr/bin/node' \
  'test ! -L /usr/bin/node' \
  'test "$(readlink -f -- /usr/bin/node)" = /usr/bin/node' \
  'test "$(stat -c '\''%u'\'' -- /usr/bin/node)" = 0' \
  'chmod 0755 /usr/bin/node'; do
  grep -Fq -- "$required" "$relay_dir/Containerfile" || {
    echo "relay static check: image lost exact Node runtime provision: $required" >&2
    exit 1
  }
done
if [[ "$(grep -Fc -- '--entrypoint /usr/bin/node' "$relay_dir/preflight.sh")" != 1 ||
      "$(grep -Fc -- '--entrypoint=/usr/bin/node' "$relay_dir/preflight.sh")" != 1 ]]; then
  echo 'relay static check: runtime probes must execute exact /usr/bin/node' >&2
  exit 1
fi
grep -Fqx 'ENTRYPOINT ["/opt/agent-deck/bin/agent-deck-relay"]' "$relay_dir/Containerfile" || {
  echo "relay static check: image must invoke the Node-only Relay entrypoint" >&2
  exit 1
}
grep -Fqx 'HEALTHCHECK NONE' "$relay_dir/Containerfile" || {
  echo "relay static check: image must clear an inherited base-image health command" >&2
  exit 1
}

if grep -Eqi '(PublishPort|ExposeHostPort|podman\.sock|docker\.sock|containerd\.sock)' \
  "$relay_dir/agent-deck-relay@.container"; then
  echo "relay static check: inbound ports and container-engine sockets are forbidden" >&2
  exit 1
fi

echo "relay static check: passed"
