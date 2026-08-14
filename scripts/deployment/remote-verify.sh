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
    DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_root/bus" \
    /usr/bin/env --chdir="$service_home" "$@"
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
else
  authority_directory="$service_home/.config/agent-deck-relay/$instance_id"
  authority_file="$authority_directory/authority.json"
  run_service /usr/bin/test -d "$authority_directory" ||
    fail 'Relay connection authority 目录不存在'
  if run_service /usr/bin/test -L "$authority_directory"; then
    fail 'Relay connection authority 目录不能是符号链接'
  fi
  [[ "$(run_service /usr/bin/readlink -f -- "$authority_directory")" == "$authority_directory" ]] ||
    fail 'Relay connection authority 目录不规范'
  [[ "$(run_service /usr/bin/stat -c '%u' -- "$authority_directory")" == "$service_uid" &&
     "$(run_service /usr/bin/stat -c '%a' -- "$authority_directory")" == 700 ]] ||
    fail 'Relay connection authority 目录 owner/mode 不匹配'
  run_service /usr/bin/test -f "$authority_file" || fail 'Relay connection authority 缺失'
  if run_service /usr/bin/test -L "$authority_file"; then
    fail 'Relay connection authority 不能是符号链接'
  fi
  [[ "$(run_service /usr/bin/readlink -f -- "$authority_file")" == "$authority_file" ]] ||
    fail 'Relay connection authority 路径不规范'
  [[ "$(run_service /usr/bin/stat -c '%u' -- "$authority_file")" == "$service_uid" &&
     "$(run_service /usr/bin/stat -c '%g' -- "$authority_file")" == "$(/usr/bin/id -g "$service_user")" &&
     "$(run_service /usr/bin/stat -c '%a' -- "$authority_file")" == 600 ]] ||
    fail 'Relay connection authority owner/mode 不匹配'
  run_service /opt/agent-deck/bin/agent-deck-relay check-authority \
    --instance "$instance_id" --authority "$authority_file"
fi

for feishu_file in \
  /opt/agent-deck/bin/agent-deck-feishu \
  /opt/agent-deck/libexec/agent-deck-feishu-preflight \
  /etc/systemd/system/agent-deck-feishu.service \
  /opt/agent-deck/feishu-runtime/active \
  /opt/agent-deck/feishu-runtime/desired; do
  [[ -f "$feishu_file" && ! -L "$feishu_file" ]] || fail 'Feishu 运行时安装不完整'
  [[ "$(/usr/bin/stat -c '%u' -- "$feishu_file")" == 0 ]] ||
    fail 'Feishu 运行时文件必须由 root 拥有'
  (( (8#$(/usr/bin/stat -c '%a' -- "$feishu_file") & 8#022) == 0 )) ||
    fail 'Feishu 运行时文件不可被非 root 写入'
done
for pointer in active desired; do
  mapfile -t pointer_lines < "/opt/agent-deck/feishu-runtime/$pointer"
  [[ ${#pointer_lines[@]} == 1 && "${pointer_lines[0]}" =~ ^[a-f0-9]{64}$ ]] ||
    fail 'Feishu 运行时指针无效'
  pointer_root="/opt/agent-deck/feishu-runtime/releases/${pointer_lines[0]}"
  [[ -d "$pointer_root" && ! -L "$pointer_root" ]] || fail 'Feishu 运行时 release 缺失'
  (
    cd "$pointer_root"
    /usr/bin/sha256sum --check --strict SHA256SUMS >/dev/null
  ) || fail 'Feishu 运行时 release 校验失败'
done
/usr/bin/sudo -n /opt/agent-deck/bin/agent-deck-feishu check-abi >/dev/null ||
  fail 'Feishu 活动运行时 ABI 校验失败'

echo "VERIFY_OK topology=$topology instance=$instance_id image=$observed_image health=$health feishuRuntime=ready"
