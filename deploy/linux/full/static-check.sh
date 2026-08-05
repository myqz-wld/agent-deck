#!/usr/bin/env bash
set -euo pipefail

full_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$full_dir/../../.." && pwd)"
template="$full_dir/agent-deck-full@.container.in"
key_fixture="$full_dir/authorized-client-key-options.txt"

fail() {
  echo "Full static check: $*" >&2
  exit 1
}

bash -n "$full_dir/preflight.sh"
bash -n "$full_dir/static-check.sh"
bash -n "$repo_root/resources/bin/agent-deckd"
bash -n "$repo_root/resources/bin/agent-deck-full-bridge"
bash "$full_dir/preflight.sh" --template "$template"

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

echo 'Full static check: passed'
