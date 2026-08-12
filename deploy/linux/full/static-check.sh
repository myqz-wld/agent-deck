#!/usr/bin/env bash
set -euo pipefail

full_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$full_dir/../../.." && pwd)"
template="$full_dir/agent-deck-full@.container.in"
key_fixture="$full_dir/authorized-client-key-options.txt"
credential_fixture="$full_dir/server-core.credentials.example.json"

fail() {
  echo "Full static check: $*" >&2
  exit 1
}

bash -n "$full_dir/preflight.sh"
bash -n "$full_dir/static-check.sh"
bash -n "$repo_root/resources/bin/agent-deckd"
bash -n "$repo_root/resources/bin/agent-deck-full-bridge"
bash -n "$repo_root/resources/bin/agent-deck-provider-supervisor"
bash "$full_dir/preflight.sh" --template "$template"
if grep -Fq 'HealthCmd=["CMD"' "$template"; then
  fail 'Podman health argv must begin with the executable, not a Dockerfile CMD marker'
fi

for surface in desktop-full feishu-session-console; do
  grep -Fq "command=\"/opt/agent-deck/bin/agent-deck-full-bridge --instance INSTANCE_ID --credential CREDENTIAL_ID --surface $surface\"" "$key_fixture" ||
    fail "authorized key does not bind the exact host bridge, instance, credential, and $surface surface"
done
if grep -Fq '/run/agent-deck/' "$key_fixture"; then
  fail 'authorized key assumes the container named-volume socket is a host path'
fi
if grep -Fq 'environment=' "$key_fixture"; then
  fail 'authorized key must not add an inherited environment option'
fi
for label in \
  'Label=io.agent-deck.instance=%i' \
  'Label=io.agent-deck.topology=full' \
  'Label=io.agent-deck.managed-by=agent-deck-instance-manager'; do
  grep -Fqx "$label" "$template" || fail "missing exact container identity label: $label"
done
if grep -Eqi '(PublishPort|ExposeHostPort|podman\.sock|docker\.sock|containerd\.sock|Network=host)' "$template"; then
  fail 'public ports, host networking, and engine sockets are forbidden'
fi

bridge_source="$repo_root/src/hosts/server-core/podman-bridge.ts"
grep -Fq "'container'," "$bridge_source" || fail 'host bridge lacks exact container inspection'
grep -Fq "'-i'," "$bridge_source" || fail 'host bridge must attach only Podman stdin/stdout'
grep -Fq "'bridge-internal'," "$bridge_source" || fail 'host bridge lacks internal executable dispatch'
grep -Fq "'/opt/agent-deck/bin/agent-deckd'," "$bridge_source" || fail 'container executable path drifted'

for wrapper in agent-deckd agent-deck-full-bridge; do
  source="$repo_root/resources/bin/$wrapper"
  grep -Fq 'exec /usr/bin/env -i' "$source" || fail "$wrapper does not clear inherited environment"
  if grep -Eq '\$\{?AGENT_DECK_(HEADLESS_ROOT|NODE)|command -v' "$source"; then
    fail "$wrapper accepts a production runtime override"
  fi
done

grep -Fq '"runtimeModule": "/opt/agent-deck/linux-headless/server-core-runtime/index.mjs"' \
  "$full_dir/server-core.config.example.json" ||
  fail 'Server Core config does not bind the packaged concrete runtime'
grep -Fq '"sessionCreationCatalog"' "$full_dir/server-core.config.example.json" ||
  fail 'Server Core config does not provision the safe Remote session catalog'
for required in \
  '"surface": "desktop-full"' \
  '"surface": "feishu-session-console"' \
  '"status": "active"'; do
  grep -Fq "$required" "$credential_fixture" ||
    fail "credential fixture lost $required"
done

for required in \
  '/run/secrets/agent-deck/provider-home' \
  '/run/secrets/agent-deck/provider-inference' \
  '.claude/.credentials.json' \
  '.codex/auth.json' \
  'Remote Grok is published as available only' \
  'Settings, hooks, MCP definitions'; do
  grep -Fq -- "$required" "$full_dir/README.snippet.md" ||
    fail "provider auth projection documentation lost: $required"
done
grep -Fq 'never projected' "$full_dir/README.snippet.md" ||
  fail 'provider auth projection documentation lost the retired Grok credential fence'
for required in \
  'agent-deck-provider-supervisor.service.in' \
  'rootless-podman-full.config.example.json' \
  'wait-ready --config' \
  'health-config --config'; do
  grep -Fq -- "$required" "$full_dir/README.snippet.md" ||
    fail "Provider supervisor provisioning documentation lost $required"
done
supervisor_unit="$repo_root/deploy/linux/provider-session/agent-deck-provider-supervisor.service.in"
for required in \
  'prepare-runtime --config @@CONFIG_PATH@@' \
  'Restart=always' \
  'wait-ready --config @@CONFIG_PATH@@'; do
  grep -Fq -- "$required" "$supervisor_unit" ||
    fail "Provider supervisor unit lost $required"
done
if grep -Eqi '(podman\.sock|docker\.sock|containerd\.sock)' "$supervisor_unit"; then
  fail 'Provider supervisor unit must not project an engine socket into Core'
fi
for required in \
  '/opt/agent-deck/linux-headless/server-core-runtime/index.mjs' \
  '/opt/agent-deck/providers/claude/claude' \
  '/opt/agent-deck/providers/codex/codex' \
  '/opt/agent-deck/providers/grok/grok'; do
  grep -Fq "$required" "$repo_root/resources/bin/agent-deckd" ||
    fail "Server Core wrapper does not verify $required"
done

for required in \
  'agent-deckd issue-connection' \
  '--credential-file /path/to/instance/secrets/credentials.json' \
  '--host-key /etc/ssh/ssh_host_ed25519_key.pub' \
  '.agentdeck-connection'; do
  grep -Fq -- "$required" "$full_dir/README.snippet.md" ||
    fail "connection credential issuance documentation lost $required"
done
grep -Fq "if (command === 'issue-connection')" \
  "$repo_root/src/hosts/server-core/entrypoint.ts" ||
  fail 'Server Core entrypoint lost one-shot connection issuance'

echo 'Full static check: passed'
