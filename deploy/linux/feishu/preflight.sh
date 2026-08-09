#!/bin/bash -p
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

config_path="${1:-/etc/agent-deck-feishu/config.json}"
core_config_path="${2:-/etc/agent-deck-feishu/core-ssh.json}"
service_user="${AGENT_DECK_FEISHU_USER:-agent-deck-feishu}"

fail() {
  printf '%s\n' "feishu-preflight: production prerequisite not verified" >&2
  exit 1
}

check_file() {
  local target="$1"
  [[ -f "$target" && ! -L "$target" ]] || fail
  [[ "$(/usr/bin/realpath -- "$target")" == "$target" ]] || fail
  [[ "$(/usr/bin/stat -c '%U' -- "$target")" == "$service_user" ]] || fail
  [[ "$(/usr/bin/stat -c '%a' -- "$target")" == "600" ]] || fail
}

check_directory() {
  local target="$1"
  [[ -d "$target" && ! -L "$target" ]] || fail
  [[ "$(/usr/bin/stat -c '%U' -- "$target")" == "$service_user" ]] || fail
  [[ "$(/usr/bin/stat -c '%a' -- "$target")" == "700" ]] || fail
  [[ "$(/usr/bin/realpath -- "$target")" == "$target" ]] || fail
}

check_config_directory() {
  local target="$1"
  [[ -d "$target" && ! -L "$target" ]] || fail
  [[ "$(/usr/bin/stat -c '%U' -- "$target")" == "root" ]] || fail
  [[ "$(/usr/bin/stat -c '%G' -- "$target")" == "$service_user" ]] || fail
  [[ "$(/usr/bin/stat -c '%a' -- "$target")" == "750" ]] || fail
  [[ "$(/usr/bin/realpath -- "$target")" == "$target" ]] || fail
}

for executable in /usr/bin/node /usr/bin/ssh /usr/bin/getent /usr/bin/curl \
  /opt/agent-deck/bin/agent-deck-feishu; do
  [[ -x "$executable" && ! -L "$executable" ]] || fail
done
check_config_directory "$(/usr/bin/dirname -- "$config_path")"
[[ "$(/usr/bin/dirname -- "$config_path")" == \
  "$(/usr/bin/dirname -- "$core_config_path")" ]] || fail
check_file "$config_path"
check_file "$core_config_path"

mapfile -t protected_paths < <(/usr/bin/node - "$config_path" "$core_config_path" <<'NODE'
const fs = require('node:fs');
const [gateway, core] = process.argv.slice(2).map((path) =>
  JSON.parse(fs.readFileSync(path, 'utf8')));
const active = gateway.credentials
  ?.filter((credential) => credential?.status === 'active')
  .map((credential) => credential?.credentialId)
  .sort();
const identities = core.credentials
  ?.map((credential) => credential?.credentialId)
  .sort();
if (
  gateway.instanceId !== core.instanceId || gateway.topology !== core.topology ||
  !Array.isArray(active) || !Array.isArray(identities) ||
  JSON.stringify(active) !== JSON.stringify(identities)
) process.exit(2);
const paths = [
  gateway.stateDirectory,
  gateway.appSecretFile,
  gateway.actionSecretFile,
  core.knownHostsFile,
  ...core.credentials.map((credential) => credential.identityFile),
  core.hostname,
];
if (
  paths.some((value) => typeof value !== 'string' || /[\r\n]/.test(value)) ||
  paths.slice(0, -1).some((value) => !value.startsWith('/'))
) process.exit(2);
process.stdout.write(paths.join('\n'));
NODE
)
path_count=${#protected_paths[@]}
(( path_count >= 6 )) || fail
check_directory "${protected_paths[0]}"
for ((index = 1; index < path_count - 1; index += 1)); do
  check_file "${protected_paths[$index]}"
done
/usr/bin/getent ahosts "${protected_paths[$((path_count - 1))]}" >/dev/null || fail
/usr/bin/getent ahosts open.feishu.cn >/dev/null || fail
/usr/bin/curl --fail --silent --show-error --head --max-time 10 \
  https://open.feishu.cn/ >/dev/null || fail
printf '%s\n' "feishu-preflight: outbound-only prerequisites verified"
