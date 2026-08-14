#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../../.." && pwd -P)"
unit="$script_dir/agent-deck-feishu.service"
gateway_example="$script_dir/config.example.json"
core_example="$script_dir/core-ssh.example.json"
wrapper="$repo_root/resources/bin/agent-deck-feishu"

fail() {
  printf '%s\n' "feishu-static-check: $*" >&2
  exit 1
}

/bin/bash -n "$script_dir/preflight.sh" "$script_dir/static-check.sh" "$wrapper"
head -n 1 "$script_dir/preflight.sh" | grep -Fqx '#!/bin/bash -p' ||
  fail 'preflight does not suppress Bash startup injection'
grep -Fq 'unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS' \
  "$script_dir/preflight.sh" || fail 'preflight does not clear loader and Node injection variables'
node -e '
  const fs = require("node:fs");
  const gateway = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const core = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (gateway.instanceId !== core.instanceId || gateway.topology !== core.topology) process.exit(1);
  const active = gateway.credentials.filter((entry) => entry.status === "active")
    .map((entry) => entry.credentialId).sort();
  const identities = core.credentials.map((entry) => entry.credentialId).sort();
  if (JSON.stringify(active) !== JSON.stringify(identities)) process.exit(1);
' "$gateway_example" "$core_example" || fail 'example bindings drifted'

for setting in \
  'NoNewPrivileges=true' \
  'ProtectSystem=strict' \
  'UMask=0077' \
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
  'ExecStartPre=/opt/agent-deck/bin/agent-deck-feishu check-abi' \
  'ExecStart=/opt/agent-deck/bin/agent-deck-feishu serve --config /etc/agent-deck-feishu/config.json --core-ssh-config /etc/agent-deck-feishu/core-ssh.json'; do
  grep -Fqx "$setting" "$unit" || fail "unit lost $setting"
done
if grep -Eiq '(^|[[:space:]])(ListenStream|ListenDatagram|PublishedPort|callbackUrl|webhookUrl)=' "$unit"; then
  fail 'inbound listener configuration is forbidden'
fi
if grep -Eiq '"(appSecret|actionSecret|privateKey)"[[:space:]]*:' \
  "$gateway_example" "$core_example"; then
  fail 'inline secrets or private keys are forbidden'
fi
grep -Fq -- '--surface feishu' \
  "$repo_root/deploy/linux/full/authorized-client-key-options.txt" ||
  fail 'Full provisioning lacks the Feishu key surface'
grep -Fq -- '--surface feishu' \
  "$repo_root/deploy/linux/relay/authorized-client-key-options.txt" ||
  fail 'Relay provisioning lacks the Feishu key surface'
grep -Fq 'exec /usr/bin/env -i' "$wrapper" || fail 'wrapper does not clear inherited environment'
grep -Fq '/usr/bin/node /opt/agent-deck/linux-headless/feishu/index.mjs' "$wrapper" ||
  fail 'wrapper bundle path drifted'
if grep -Eq '\$\{?AGENT_DECK_(HEADLESS_ROOT|NODE)|command -v' "$wrapper"; then
  fail 'wrapper accepts a production runtime override'
fi
node -e '
  const packageJson = require(process.argv[1]);
  if (packageJson.dependencies?.["@larksuiteoapi/node-sdk"] !== "1.70.0") process.exit(1);
  if (packageJson.scripts?.["verify:linux-headless"] !==
    "pnpm build:linux-headless && pnpm check:linux-headless && pnpm check:deployment") process.exit(1);
' "$repo_root/package.json" || fail 'SDK pin or Linux root script drifted'
printf '%s\n' 'feishu-static-check: passed'
