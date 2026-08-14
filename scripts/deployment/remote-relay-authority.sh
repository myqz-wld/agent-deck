#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

fail() {
  echo "Relay connection authority 初始化失败：$*" >&2
  exit 1
}

mode=${1:-}
service_user=${2:-}
service_uid=${3:-}
service_home=${4:-}
instance_id=${5:-}
[[ "$mode" == create || "$mode" == verify ]] || fail 'mode 无效'
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'service user 无效'
[[ "$service_uid" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'service uid 无效'
[[ "$service_home" == /var/lib/agent-deck ]] || fail 'service home 无效'
[[ "$instance_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'instance id 无效'
[[ "$(/usr/bin/id -u "$service_user")" == "$service_uid" ]] || fail 'service user/uid 不匹配'

run_service() {
  /usr/bin/sudo -n -u "$service_user" /usr/bin/env -i \
    HOME="$service_home" PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    /usr/bin/env --chdir="$service_home" "$@"
}

config_directory="$service_home/.config/agent-deck-relay/$instance_id"
authority_file="$config_directory/authority.json"
run_service /usr/bin/test -d "$config_directory" || fail '配置目录不存在或不是常规目录'
if run_service /usr/bin/test -L "$config_directory"; then fail '配置目录不能是符号链接'; fi
[[ "$(run_service /usr/bin/readlink -f -- "$config_directory")" == "$config_directory" ]] || fail '配置目录不规范'
[[ "$(run_service /usr/bin/stat -c '%u' -- "$config_directory")" == "$service_uid" &&
   "$(run_service /usr/bin/stat -c '%g' -- "$config_directory")" == "$(/usr/bin/id -g "$service_user")" &&
   "$(run_service /usr/bin/stat -c '%a' -- "$config_directory")" == 700 ]] ||
  fail '配置目录 owner/mode 不匹配'

created=0
authority_present=0
if run_service /usr/bin/test -e "$authority_file" ||
   run_service /usr/bin/test -L "$authority_file"; then
  authority_present=1
fi
if ((authority_present == 0)); then
  [[ "$mode" == create ]] || fail 'connection authority 不存在'
  run_service /usr/bin/node -e '
    const fs = require("node:fs");
    const [path, instanceId] = process.argv.slice(1);
    const fd = fs.openSync(path, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, instanceId, credentials: [] }, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directory = fs.openSync(require("node:path").dirname(path), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  ' "$authority_file" "$instance_id"
  created=1
fi

run_service /usr/bin/test -f "$authority_file" || fail 'connection authority 不是常规文件'
if run_service /usr/bin/test -L "$authority_file"; then fail 'connection authority 不能是符号链接'; fi
[[ "$(run_service /usr/bin/readlink -f -- "$authority_file")" == "$authority_file" ]] || fail 'connection authority 路径不规范'
[[ "$(run_service /usr/bin/stat -c '%u' -- "$authority_file")" == "$service_uid" &&
   "$(run_service /usr/bin/stat -c '%g' -- "$authority_file")" == "$(/usr/bin/id -g "$service_user")" &&
   "$(run_service /usr/bin/stat -c '%a' -- "$authority_file")" == 600 ]] ||
  fail 'connection authority owner/mode 不匹配'
run_service /opt/agent-deck/bin/agent-deck-relay check-authority \
  --instance "$instance_id" --authority "$authority_file"

if ((created == 1)); then
  echo 'RELAY_AUTHORITY_CREATED'
else
  echo 'RELAY_AUTHORITY_READY'
fi
