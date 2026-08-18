#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

fail() {
  echo "远程实例管理失败：$*" >&2
  exit 1
}

service_user=${1:-}
service_uid=${2:-}
request_source=${3:-}
request_id=${4:-}
command=${5:-}
service_home=/var/lib/agent-deck
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'service user 无效'
[[ "$service_uid" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'service uid 无效'
[[ "$request_source" =~ ^/tmp/agent-deck-request-[a-z0-9-]+\.json$ && -f "$request_source" && ! -L "$request_source" ]] || fail 'request source 无效'
[[ "$request_id" =~ ^[a-z0-9-]{1,80}$ ]] || fail 'request id 无效'
case "$command" in
  plan-create|create|start|status|describe|plan-upgrade|upgrade|plan-rollback|rollback) ;;
  *) fail 'manager command 无效' ;;
esac
[[ "$(/usr/bin/id -u "$service_user")" == "$service_uid" ]] || fail 'service user/uid 不匹配'
service_group="$(/usr/bin/id -gn "$service_user")"
request_target="/var/lib/agent-deck-manager/requests/${request_id}.json"
cleanup() {
  /usr/bin/sudo -n /bin/rm -f -- "$request_target"
  /bin/rm -f -- "$request_source"
}
trap cleanup EXIT
/usr/bin/sudo -n /usr/bin/install -o "$service_user" -g "$service_group" -m 0600 -T \
  -- "$request_source" "$request_target"
/usr/bin/sudo -n -u "$service_user" /usr/bin/env -i PATH=/usr/bin:/bin \
  /usr/bin/env --chdir="$service_home" \
  /opt/agent-deck/bin/agent-deck-instance-manager "$command" \
  --config /etc/agent-deck-manager/config.json \
  --request "$request_target"
