#!/usr/bin/env bash
set -euo pipefail

relay_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash -n "$relay_dir/preflight.sh"
bash -n "$relay_dir/static-check.sh"
bash "$relay_dir/preflight.sh" \
  --quadlet "$relay_dir/agent-deck-relay@.container" \
  --static-only

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  if (manifest.topology !== "relay" || manifest.rootless !== true) process.exit(1);
  if (!Array.isArray(manifest.publishedPorts) || manifest.publishedPorts.length !== 0) process.exit(1);
  if (manifest.quadletTemplate !== "agent-deck-relay@.container") process.exit(1);
  if (manifest.instanceSpecifier !== "%i" || manifest.engineSocketMounted !== false) process.exit(1);
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
  const control = manifest.controlSocket;
  if (control.hostSocketTemplate !== "%t/agent-deck-relay/%i/control.sock") process.exit(1);
  if (control.containerSocketTemplate !== "/run/agent-deck-relay/%i/control.sock") process.exit(1);
  if (control.socketMode !== "0600" || control.publicPortFallback !== false) process.exit(1);
  const evidence = manifest.evidenceStorage;
  if (evidence.pathTemplate !== "/etc/agent-deck-relay/evidence/%i") process.exit(1);
  if (evidence.owner !== "root" || evidence.relayServiceWritable !== false) process.exit(1);
  if (manifest.configAcceptanceGate.containerReadOnly !== true) process.exit(1);
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
cleanup_fixture
trap - EXIT

if ! grep -Eq '^restrict,command="[^"]+",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-' \
  "$relay_dir/authorized-key-options.txt"; then
  echo "relay static check: Worker public key must force attach and disable SSH expansion" >&2
  exit 1
fi

if grep -Eqi '(@openai/codex|claude-agent-sdk|xai-official|chrom(e|ium)|better-sqlite3|git[[:space:]]+workspace)' \
  "$relay_dir/Containerfile" "$relay_dir/agent-deck-relay@.container"; then
  echo "relay static check: forbidden full-Core build content found" >&2
  exit 1
fi

if grep -Eqi '(PublishPort|ExposeHostPort|podman\.sock|docker\.sock|containerd\.sock)' \
  "$relay_dir/agent-deck-relay@.container"; then
  echo "relay static check: inbound ports and container-engine sockets are forbidden" >&2
  exit 1
fi

echo "relay static check: passed"
