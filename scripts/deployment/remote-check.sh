#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

fail() {
  echo "远程部署预检失败：$*" >&2
  exit 1
}

topology=${1:-}
service_user=${2:-}
service_uid=${3:-}
service_home=${4:-}
instance_id=${5:-}
[[ "$topology" == relay || "$topology" == full ]] || fail 'topology 无效'
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'service user 无效'
[[ "$service_uid" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'service uid 无效'
[[ "$service_home" == /var/lib/agent-deck ]] || fail 'service home 无效'
[[ "$instance_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'instance id 无效'
[[ "$(uname -s)" == Linux ]] || fail '目标必须是 Linux'

for executable in /usr/bin/node /usr/bin/podman /usr/bin/sudo /usr/bin/systemctl \
  /usr/bin/loginctl /usr/bin/install /usr/bin/tar /usr/bin/stat /usr/bin/readlink \
  /usr/bin/mktemp /usr/bin/find /usr/bin/sed /usr/bin/sort /usr/bin/id /usr/bin/env; do
  [[ -x "$executable" && ! -L "$executable" ]] || fail "缺少非符号链接可执行文件 $executable"
done
/usr/bin/sudo -n true || fail 'SSH 管理用户缺少免交互 sudo'
[[ "$(/usr/bin/id -u "$service_user")" == "$service_uid" ]] || fail 'service user/uid 不匹配'
[[ -d "$service_home" && ! -L "$service_home" ]] || fail 'service home 不存在或是符号链接'
[[ "$(/usr/bin/stat -c '%u' "$service_home")" == "$service_uid" ]] || fail 'service home owner 不匹配'
(( (8#$(/usr/bin/stat -c '%a' "$service_home") & 8#077) == 0 )) || fail 'service home 必须为 mode 0700'
node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || fail '需要 Node.js 22 或更高版本'
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail '需要 cgroup v2'

runtime_root="/run/user/$service_uid"
[[ -d "$runtime_root" && ! -L "$runtime_root" ]] || fail 'systemd user runtime 尚未就绪；部署前请启用 linger'
run_service() {
  /usr/bin/sudo -n -u "$service_user" /usr/bin/env -i \
    HOME="$service_home" PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    XDG_RUNTIME_DIR="$runtime_root" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_root/bus" "$@"
}
[[ "$(run_service /usr/bin/podman info --format '{{.Host.Security.Rootless}}')" == true ]] ||
  fail 'Podman 必须以 rootless 模式运行'
run_service /usr/bin/systemctl --user show-environment >/dev/null || fail 'systemd user manager 不可用'
if [[ "$topology" == full ]]; then
  run_service /usr/bin/podman network exists "agent-deck-${instance_id}-egress" ||
    fail 'Full 所需的已验收 egress network 尚不存在'
fi

echo 'REMOTE_CHECK_OK'
