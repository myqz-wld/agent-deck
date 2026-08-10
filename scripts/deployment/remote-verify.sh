#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

fail() {
  echo "远程部署验证失败：$*" >&2
  exit 1
}

topology=${1:-}
service_user=${2:-}
service_uid=${3:-}
service_home=${4:-}
instance_id=${5:-}
expected_image=${6:--}
[[ "$topology" == relay || "$topology" == full ]] || fail 'topology 无效'
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'service user 无效'
[[ "$service_uid" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'service uid 无效'
[[ "$service_home" =~ ^/[A-Za-z0-9._/-]+$ && "$service_home" != / ]] || fail 'service home 无效'
[[ "$instance_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'instance id 无效'
[[ "$expected_image" == - || "$expected_image" =~ @sha256:[a-f0-9]{64}$ ]] || fail 'expected image 无效'
[[ "$(/usr/bin/id -u "$service_user")" == "$service_uid" ]] || fail 'service user/uid 不匹配'

runtime_root="/run/user/$service_uid"
run_service() {
  /usr/bin/sudo -n -u "$service_user" /usr/bin/env -i \
    HOME="$service_home" PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    XDG_RUNTIME_DIR="$runtime_root" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_root/bus" "$@"
}
unit_name="agent-deck-${topology}@${instance_id}.service"
container_name="agent-deck-${topology}-${instance_id}"
[[ "$(run_service /usr/bin/systemctl --user is-active "$unit_name")" == active ]] || fail 'systemd user unit 不是 active'
[[ "$(run_service /usr/bin/podman inspect --format '{{.State.Running}}' -- "$container_name")" == true ]] || fail 'container 未运行'
health="$(run_service /usr/bin/podman inspect --format '{{.State.Health.Status}}' -- "$container_name")"
[[ "$health" == healthy ]] || fail "container health=$health"
observed_image="$(run_service /usr/bin/podman inspect --format '{{.ImageName}}' -- "$container_name")"
if [[ "$expected_image" != - && "$observed_image" != "$expected_image" ]]; then
  fail 'container image 与期望 digest 不一致'
fi
if [[ "$topology" == full ]]; then
  [[ "$(run_service /usr/bin/podman inspect --format '{{index .Config.Labels "io.agent-deck.instance"}}' -- "$container_name")" == "$instance_id" ]] || fail 'Full instance label 不匹配'
  [[ "$(run_service /usr/bin/podman inspect --format '{{index .Config.Labels "io.agent-deck.managed-by"}}' -- "$container_name")" == agent-deck-instance-manager ]] || fail 'Full manager label 不匹配'
fi

echo "VERIFY_OK topology=$topology instance=$instance_id image=$observed_image health=$health"
