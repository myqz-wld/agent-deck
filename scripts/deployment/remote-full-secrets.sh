#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

fail() {
  echo "Full secrets 初始化失败：$*" >&2
  exit 1
}

archive=${1:-}
service_user=${2:-}
service_uid=${3:-}
service_home=${4:-}
instance_id=${5:-}
[[ "$archive" =~ ^/tmp/agent-deck-secrets-[a-z0-9-]+\.tgz$ && -f "$archive" && ! -L "$archive" ]] || fail 'secrets archive 无效'
(( (8#$(/usr/bin/stat -c '%a' "$archive") & 8#077) == 0 )) || fail 'secrets archive 权限过宽'
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'service user 无效'
[[ "$service_uid" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'service uid 无效'
[[ "$service_home" == /var/lib/agent-deck ]] || fail 'service home 无效'
[[ "$instance_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'instance id 无效'
[[ "$(/usr/bin/id -u "$service_user")" == "$service_uid" ]] || fail 'service user/uid 不匹配'

source_root="$(/usr/bin/mktemp -d /tmp/agent-deck-secrets.XXXXXX)"
cleanup() {
  /bin/rm -rf -- "$source_root"
  /bin/rm -f -- "$archive"
}
trap cleanup EXIT
/usr/bin/tar -xzf "$archive" -C "$source_root" --no-same-owner --no-same-permissions
[[ -f "$source_root/agent-deck/credentials.json" && ! -L "$source_root/agent-deck/credentials.json" ]] || fail 'credentials.json 缺失'
if [[ -n "$(/usr/bin/find "$source_root" -type l -print -quit)" ]]; then
  fail 'secrets archive 包含符号链接'
fi
while IFS= read -r relative_path; do
  case "$relative_path" in
    agent-deck/credentials.json|agent-deck/provider-home/.claude/.credentials.json|agent-deck/provider-home/.codex/auth.json|agent-deck/provider-inference/grok-auth.json) ;;
    *) fail "secrets archive 包含未允许文件 $relative_path" ;;
  esac
done < <(cd "$source_root" && /usr/bin/find . -type f -print | /usr/bin/sed 's#^\./##' | /usr/bin/sort)

runtime_root="/run/user/$service_uid"
run_service() {
  /usr/bin/sudo -n -u "$service_user" /usr/bin/env -i \
    HOME="$service_home" PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    XDG_RUNTIME_DIR="$runtime_root" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_root/bus" \
    /usr/bin/env --chdir="$service_home" "$@"
}
volume="agent-deck-${instance_id}-secrets"
[[ "$(run_service /usr/bin/podman volume inspect --format '{{index .Labels "io.agent-deck.instance"}}' -- "$volume")" == "$instance_id" ]] || fail 'secrets volume instance label 不匹配'
[[ "$(run_service /usr/bin/podman volume inspect --format '{{index .Labels "io.agent-deck.purpose"}}' -- "$volume")" == secrets ]] || fail 'secrets volume purpose label 不匹配'
[[ "$(run_service /usr/bin/podman volume inspect --format '{{index .Labels "io.agent-deck.managed-by"}}' -- "$volume")" == instance-manager ]] || fail 'secrets volume manager label 不匹配'
mountpoint="$(run_service /usr/bin/podman volume inspect --format '{{.Mountpoint}}' -- "$volume")"
[[ "$mountpoint" == "$service_home"/* ]] || fail 'secrets volume mountpoint 无效'
/usr/bin/sudo -n /usr/bin/test -d "$mountpoint" || fail 'secrets volume mountpoint 不存在'
/usr/bin/sudo -n /usr/bin/test ! -L "$mountpoint" || fail 'secrets volume mountpoint 不能是符号链接'
[[ "$(/usr/bin/sudo -n /usr/bin/readlink -f -- "$mountpoint")" == "$mountpoint" ]] || fail 'secrets volume mountpoint 不规范'
service_group="$(/usr/bin/id -gn "$service_user")"

/usr/bin/sudo -n /usr/bin/install -d -o "$service_user" -g "$service_group" -m 0700 \
  "$mountpoint/agent-deck" \
  "$mountpoint/agent-deck/provider-home" \
  "$mountpoint/agent-deck/provider-inference"
for optional_root in .claude .codex; do
  /usr/bin/sudo -n /usr/bin/install -d -o "$service_user" -g "$service_group" -m 0700 \
    "$mountpoint/agent-deck/provider-home/$optional_root"
done
install_secret() {
  local source=$1 target=$2
  [[ ! -f "$source" ]] || /usr/bin/sudo -n /usr/bin/install \
    -o "$service_user" -g "$service_group" -m 0600 -T -- "$source" "$target"
}
install_secret "$source_root/agent-deck/credentials.json" \
  "$mountpoint/agent-deck/credentials.json"
install_secret "$source_root/agent-deck/provider-home/.claude/.credentials.json" \
  "$mountpoint/agent-deck/provider-home/.claude/.credentials.json"
install_secret "$source_root/agent-deck/provider-home/.codex/auth.json" \
  "$mountpoint/agent-deck/provider-home/.codex/auth.json"
install_secret "$source_root/agent-deck/provider-inference/grok-auth.json" \
  "$mountpoint/agent-deck/provider-inference/grok-auth.json"

echo 'FULL_SECRETS_INSTALL_OK'
