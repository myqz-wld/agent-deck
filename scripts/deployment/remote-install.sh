#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

fail() {
  echo "远程 release 安装失败：$*" >&2
  exit 1
}

archive=${1:-}
topology=${2:-}
service_user=${3:-}
service_uid=${4:-}
service_home=${5:-}
instance_id=${6:-}
version=${7:-}
relay_repository=${8:-}
input_image=${9:-}
[[ "$archive" =~ ^/tmp/agent-deck-release-[a-z0-9-]+\.tgz$ && -f "$archive" && ! -L "$archive" ]] || fail 'release archive 无效'
[[ "$topology" == relay || "$topology" == full ]] || fail 'topology 无效'
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'service user 无效'
[[ "$service_uid" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'service uid 无效'
[[ "$service_home" == /var/lib/agent-deck ]] || fail 'service home 无效'
[[ "$instance_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'instance id 无效'
[[ "$version" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'version 无效'
[[ "$input_image" =~ @sha256:[a-f0-9]{64}$ ]] || fail 'input image 未固定 digest'
if [[ "$topology" == relay ]]; then
  [[ "$relay_repository" =~ ^(localhost/)?[a-z0-9]+([._/-][a-z0-9]+)*$ ]] || fail 'Relay repository 无效'
else
  [[ "$relay_repository" == - ]] || fail 'Full 不接受 Relay repository'
fi

release_root="$(/usr/bin/mktemp -d /tmp/agent-deck-release.XXXXXX)"
runtime_stage=''
cleanup() {
  if [[ "$runtime_stage" == /opt/agent-deck/feishu-runtime/.install.* ]]; then
    /usr/bin/sudo -n /bin/rm -rf -- "$runtime_stage"
  fi
  /bin/rm -rf -- "$release_root"
  if [[ "$archive" == /tmp/agent-deck-release-*.tgz ]]; then
    /bin/rm -f -- "$archive"
  fi
}
trap cleanup EXIT
/usr/bin/tar -xzf "$archive" -C "$release_root" --no-same-owner --no-same-permissions
if [[ -n "$(/usr/bin/find "$release_root" -type l -print -quit)" ]]; then
  fail 'release archive 包含符号链接'
fi
/bin/rm -f -- "$archive"
archive=''
/bin/chmod -R u=rwX,go=rX "$release_root"

required=(
  build/linux-headless/instance-manager/index.mjs
  build/linux-headless/relay/index.mjs
  build/linux-headless/server-core-host-bridge/index.mjs
  build/linux-headless/server-control/index.mjs
  resources/bin/agent-deck-instance-manager
  resources/bin/agent-deck-relay
  resources/bin/agent-deck-relay-health-gate
  resources/bin/agent-deck-full-bridge
  resources/bin/agent-deck-server
  resources/bin/agent-deck-feishu
  deploy/linux/full/agent-deck-full@.container.in
  deploy/linux/full/preflight.sh
  deploy/linux/relay/agent-deck-relay@.container
  deploy/linux/relay/preflight.sh
  deploy/linux/relay/Containerfile
  deploy/linux/relay/relay.config.example.json
  deploy/linux/relay/relay-authority.example.json
  deploy/linux/full/server-control.config.example.json
  deploy/linux/relay/server-control.config.example.json
  deploy/linux/feishu/README.md
  deploy/linux/feishu/config.example.json
  deploy/linux/feishu/core-ssh.example.json
  deploy/linux/feishu/connect.request.example.json
  deploy/linux/feishu/disconnect.request.example.json
  deploy/linux/feishu/credential-rotate.request.example.json
  deploy/linux/feishu/agent-deck-feishu.service
  deploy/linux/feishu/agent-deck-feishu.sysusers
  deploy/linux/feishu/agent-deck-feishu.tmpfiles
  deploy/linux/feishu/preflight.sh
  config/instance-manager.json
)
for relative_path in "${required[@]}"; do
  [[ -f "$release_root/$relative_path" && ! -L "$release_root/$relative_path" ]] || fail "release 缺少 $relative_path"
done

case "$(/usr/bin/uname -m)" in
  x86_64)
    runtime_architecture=amd64
    runtime_base_image='docker.io/library/node@sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644'
    ;;
  aarch64)
    runtime_architecture=arm64
    runtime_base_image='docker.io/library/node@sha256:111d09056e51bb52d1bfca06a3e73476d6022b156dc4c36c5379503cd307660b'
    ;;
  *) fail 'Feishu 运行时不支持目标 CPU 架构' ;;
esac
runtime_basename="agent-deck-feishu-runtime-linux-${runtime_architecture}"
runtime_artifact="$release_root/build/feishu-runtime/linux-${runtime_architecture}/${runtime_basename}.tgz"
runtime_checksum="$runtime_artifact.sha256"
runtime_descriptor="$release_root/build/feishu-runtime/linux-${runtime_architecture}/${runtime_basename}.json"
for runtime_file in "$runtime_artifact" "$runtime_checksum" "$runtime_descriptor"; do
  [[ -f "$runtime_file" && ! -L "$runtime_file" ]] || fail 'release 缺少目标架构的 Feishu 运行时'
done
read -r runtime_digest runtime_size < <(/usr/bin/node - \
  "$runtime_descriptor" "$runtime_architecture" "${runtime_basename}.tgz" \
  "$runtime_base_image" <<'NODE'
const fs = require('node:fs');
const [path, architecture, artifact, baseImage] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
const keys = [
  'architecture', 'artifact', 'baseImage', 'betterSqlite3Version', 'libc', 'nodeAbi',
  'nodeVersion', 'platform', 'releaseVersion', 'schemaVersion', 'sha256', 'size',
];
if (
  !value || typeof value !== 'object' || Array.isArray(value) ||
  JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
  value.schemaVersion !== 1 || value.artifact !== artifact ||
  value.platform !== 'linux' || value.architecture !== architecture ||
  value.libc !== 'glibc' || value.nodeVersion !== '22.22.3' || value.nodeAbi !== 127 ||
  value.betterSqlite3Version !== '11.10.0' || value.baseImage !== baseImage ||
  typeof value.releaseVersion !== 'string' || value.releaseVersion.length === 0 ||
  typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
  !Number.isSafeInteger(value.size) || value.size <= 0
) process.exit(2);
process.stdout.write(`${value.sha256} ${value.size}\n`);
NODE
) || fail 'Feishu 运行时描述文件无效'
[[ "$runtime_digest" =~ ^[a-f0-9]{64}$ && "$runtime_size" =~ ^[1-9][0-9]*$ ]] ||
  fail 'Feishu 运行时描述值无效'
mapfile -t runtime_checksum_lines < "$runtime_checksum"
[[ ${#runtime_checksum_lines[@]} == 1 && \
  "${runtime_checksum_lines[0]}" == "$runtime_digest  ${runtime_basename}.tgz" ]] ||
  fail 'Feishu 运行时外层 checksum 无效'
[[ "$(/usr/bin/stat -c '%s' -- "$runtime_artifact")" == "$runtime_size" ]] ||
  fail 'Feishu 运行时大小不匹配'
[[ "$(/usr/bin/sha256sum -- "$runtime_artifact" | /usr/bin/cut -d ' ' -f 1)" == \
  "$runtime_digest" ]] || fail 'Feishu 运行时 digest 不匹配'
if [[ "$runtime_architecture" == amd64 ]]; then
  unused_runtime_architecture=arm64
else
  unused_runtime_architecture=amd64
fi
/bin/rm -rf -- "$release_root/build/feishu-runtime/linux-$unused_runtime_architecture"

validate_runtime_tree() {
  local root=$1 runtime_path
  if [[ -n "$(/usr/bin/find "$root" ! -type d ! -type f -print -quit)" ]]; then
    fail 'Feishu 运行时包含不允许的文件类型'
  fi
  for runtime_path in bin/node app/index.mjs runtime.json SHA256SUMS; do
    [[ -f "$root/$runtime_path" && ! -L "$root/$runtime_path" ]] ||
      fail "Feishu 运行时缺少 $runtime_path"
  done
  (
    cd "$root"
    /usr/bin/sha256sum --check --strict SHA256SUMS >/dev/null
  ) || fail 'Feishu 运行时内部 checksum 无效'
  /bin/chmod 0755 "$root/bin/node"
  "$root/bin/node" - "$root/runtime.json" \
    "$runtime_architecture" "$runtime_base_image" <<'NODE' || fail 'Feishu 运行时清单或 ABI 无效'
const fs = require('node:fs');
const [path, architecture, baseImage] = process.argv.slice(2);
const expectedNodeArch = architecture === 'amd64' ? 'x64' : 'arm64';
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
const keys = [
  'architecture', 'baseImage', 'betterSqlite3Version', 'bundle', 'libc', 'node',
  'nodeAbi', 'nodeVersion', 'platform', 'releaseVersion', 'schemaVersion',
];
if (
  JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
  value.schemaVersion !== 1 || value.platform !== 'linux' ||
  value.architecture !== architecture || value.libc !== 'glibc' ||
  value.nodeVersion !== '22.22.3' || value.nodeAbi !== 127 ||
  value.betterSqlite3Version !== '11.10.0' || value.baseImage !== baseImage ||
  value.node !== 'bin/node' || value.bundle !== 'app/index.mjs' ||
  process.platform !== 'linux' || process.arch !== expectedNodeArch ||
  process.version !== 'v22.22.3' || Number(process.versions.modules) !== 127
) process.exit(2);
const Database = require(process.argv[2].replace(/runtime\.json$/, 'node_modules/better-sqlite3'));
const db = new Database(':memory:');
db.prepare('select 1').get();
db.close();
NODE
}

[[ "$(/usr/bin/id -u "$service_user")" == "$service_uid" ]] || fail 'service user/uid 不匹配'
service_group="$(/usr/bin/id -gn "$service_user")"
runtime_root="/run/user/$service_uid"
/usr/bin/sudo -n /usr/bin/loginctl enable-linger "$service_user" >/dev/null
/usr/bin/sudo -n /usr/bin/systemctl start "user@${service_uid}.service"
[[ -d "$runtime_root" && ! -L "$runtime_root" ]] || fail 'systemd user runtime 未就绪'

/usr/bin/sudo -n /usr/bin/install -d -o "$service_user" -g "$service_group" -m 0700 \
  "$service_home" \
  "$service_home/.config" \
  "$service_home/.config/containers" \
  "$service_home/.config/containers/systemd" \
  /var/lib/agent-deck-manager \
  /var/lib/agent-deck-manager/metadata \
  /var/lib/agent-deck-manager/backups \
  /var/lib/agent-deck-manager/journals \
  /var/lib/agent-deck-manager/locks \
  /var/lib/agent-deck-manager/requests
/usr/bin/sudo -n /usr/bin/install -d -o root -g root -m 0755 \
  /opt/agent-deck \
  /opt/agent-deck/bin \
  /opt/agent-deck/libexec \
  /opt/agent-deck/linux-headless \
  /opt/agent-deck/linux-headless/instance-manager \
  /opt/agent-deck/linux-headless/relay \
  /opt/agent-deck/linux-headless/server-core-host-bridge \
  /opt/agent-deck/linux-headless/server-control \
  /opt/agent-deck/feishu-runtime \
  /opt/agent-deck/feishu-runtime/releases \
  /opt/agent-deck/share \
  /opt/agent-deck/share/full \
  /opt/agent-deck/share/relay \
  /opt/agent-deck/share/feishu
/usr/bin/sudo -n /usr/bin/install -d -o root -g root -m 0555 \
  /etc/agent-deck-manager \
  /etc/agent-deck-manager/evidence \
  /etc/agent-deck-manager/evidence/full \
  /etc/agent-deck-manager/evidence/relay \
  /etc/agent-deck-relay \
  /etc/agent-deck-relay/evidence

install_root_file() {
  local source=$1 target=$2 mode=$3
  /usr/bin/sudo -n /usr/bin/install -o root -g root -m "$mode" -T -- "$source" "$target"
}
install_root_file "$release_root/build/linux-headless/instance-manager/index.mjs" \
  /opt/agent-deck/linux-headless/instance-manager/index.mjs 0644
install_root_file "$release_root/build/linux-headless/relay/index.mjs" \
  /opt/agent-deck/linux-headless/relay/index.mjs 0644
install_root_file "$release_root/build/linux-headless/server-core-host-bridge/index.mjs" \
  /opt/agent-deck/linux-headless/server-core-host-bridge/index.mjs 0644
install_root_file "$release_root/build/linux-headless/server-control/index.mjs" \
  /opt/agent-deck/linux-headless/server-control/index.mjs 0644
install_root_file "$release_root/resources/bin/agent-deck-instance-manager" \
  /opt/agent-deck/bin/agent-deck-instance-manager 0755
install_root_file "$release_root/resources/bin/agent-deck-relay" \
  /opt/agent-deck/bin/agent-deck-relay 0755
install_root_file "$release_root/resources/bin/agent-deck-relay-health-gate" \
  /opt/agent-deck/bin/agent-deck-relay-health-gate 0755
install_root_file "$release_root/resources/bin/agent-deck-full-bridge" \
  /opt/agent-deck/bin/agent-deck-full-bridge 0755
install_root_file "$release_root/resources/bin/agent-deck-server" \
  /opt/agent-deck/bin/agent-deck-server 0755
install_root_file "$release_root/resources/bin/agent-deck-feishu" \
  /opt/agent-deck/bin/agent-deck-feishu 0755
install_root_file "$release_root/deploy/linux/full/agent-deck-full@.container.in" \
  /opt/agent-deck/share/full/agent-deck-full@.container.in 0444
install_root_file "$release_root/deploy/linux/full/preflight.sh" \
  /opt/agent-deck/libexec/agent-deck-full-preflight 0555
install_root_file "$release_root/deploy/linux/relay/agent-deck-relay@.container" \
  /opt/agent-deck/share/relay/agent-deck-relay@.container 0444
install_root_file "$release_root/deploy/linux/relay/preflight.sh" \
  /opt/agent-deck/libexec/agent-deck-relay-preflight 0555
install_root_file "$release_root/deploy/linux/full/server-control.config.example.json" \
  /opt/agent-deck/share/full/server-control.config.example.json 0444
install_root_file "$release_root/deploy/linux/relay/server-control.config.example.json" \
  /opt/agent-deck/share/relay/server-control.config.example.json 0444
install_root_file "$release_root/deploy/linux/relay/relay.config.example.json" \
  /opt/agent-deck/share/relay/relay.config.example.json 0444
install_root_file "$release_root/deploy/linux/relay/relay-authority.example.json" \
  /opt/agent-deck/share/relay/relay-authority.example.json 0444
for feishu_example in \
  README.md config.example.json core-ssh.example.json connect.request.example.json \
  disconnect.request.example.json credential-rotate.request.example.json; do
  install_root_file "$release_root/deploy/linux/feishu/$feishu_example" \
    "/opt/agent-deck/share/feishu/$feishu_example" 0444
done
install_root_file "$release_root/deploy/linux/feishu/preflight.sh" \
  /opt/agent-deck/libexec/agent-deck-feishu-preflight 0555
install_root_file "$release_root/deploy/linux/feishu/agent-deck-feishu.service" \
  /etc/systemd/system/agent-deck-feishu.service 0644
/usr/bin/sudo -n /usr/bin/install -d -o root -g root -m 0755 \
  /usr/lib/sysusers.d /usr/lib/tmpfiles.d
install_root_file "$release_root/deploy/linux/feishu/agent-deck-feishu.sysusers" \
  /usr/lib/sysusers.d/agent-deck-feishu.conf 0644
install_root_file "$release_root/deploy/linux/feishu/agent-deck-feishu.tmpfiles" \
  /usr/lib/tmpfiles.d/agent-deck-feishu.conf 0644
install_root_file "$release_root/config/instance-manager.json" \
  /etc/agent-deck-manager/config.json 0444

runtime_target="/opt/agent-deck/feishu-runtime/releases/$runtime_digest"
if [[ ! -e "$runtime_target" ]]; then
  runtime_stage="$(/usr/bin/sudo -n /usr/bin/mktemp -d \
    /opt/agent-deck/feishu-runtime/.install.XXXXXX)"
  [[ "$runtime_stage" == /opt/agent-deck/feishu-runtime/.install.* ]] ||
    fail 'Feishu 运行时暂存目录无效'
  installer_uid="$(/usr/bin/id -u)"
  installer_gid="$(/usr/bin/id -g)"
  /usr/bin/sudo -n /bin/chown "$installer_uid:$installer_gid" -- "$runtime_stage"
  /usr/bin/sudo -n /bin/chmod 0700 -- "$runtime_stage"
  /usr/bin/tar -xzf "$runtime_artifact" -C "$runtime_stage" \
    --no-same-owner --no-same-permissions
  validate_runtime_tree "$runtime_stage"
  /usr/bin/sudo -n /bin/chown -R root:root -- "$runtime_stage"
  /usr/bin/sudo -n /usr/bin/find "$runtime_stage" -type d -exec /bin/chmod 0755 {} +
  /usr/bin/sudo -n /usr/bin/find "$runtime_stage" -type f -exec /bin/chmod 0644 {} +
  /usr/bin/sudo -n /bin/chmod 0755 "$runtime_stage/bin/node"
  /usr/bin/sudo -n /bin/mv -T -- "$runtime_stage" "$runtime_target"
  runtime_stage=''
fi
[[ -d "$runtime_target" && ! -L "$runtime_target" ]] || fail 'Feishu 运行时安装目标无效'
if [[ -n "$(/usr/bin/find "$runtime_target" ! -type d ! -type f -print -quit)" ]]; then
  fail '已安装 Feishu 运行时包含不允许的文件类型'
fi
(
  cd "$runtime_target"
  /usr/bin/sha256sum --check --strict SHA256SUMS >/dev/null
) || fail '已安装 Feishu 运行时校验失败'
/bin/rm -rf -- "$release_root/build/feishu-runtime"
pointer_source="$release_root/feishu-runtime-pointer"
printf '%s\n' "$runtime_digest" > "$pointer_source"
install_runtime_pointer() {
  local name=$1 stage
  stage="$(/usr/bin/sudo -n /usr/bin/mktemp \
    "/opt/agent-deck/feishu-runtime/.${name}.XXXXXX")"
  [[ "$stage" == "/opt/agent-deck/feishu-runtime/.${name}."* ]] ||
    fail 'Feishu 运行时指针暂存文件无效'
  /usr/bin/sudo -n /usr/bin/install -o root -g root -m 0644 -T -- \
    "$pointer_source" "$stage"
  /usr/bin/sudo -n /bin/mv -T -- "$stage" "/opt/agent-deck/feishu-runtime/$name"
}
install_runtime_pointer desired
if [[ ! -e /opt/agent-deck/feishu-runtime/active ]]; then
  install_runtime_pointer active
fi
/usr/bin/sudo -n /usr/bin/systemd-sysusers /usr/lib/sysusers.d/agent-deck-feishu.conf
/usr/bin/sudo -n /usr/bin/systemd-tmpfiles --create \
  /usr/lib/tmpfiles.d/agent-deck-feishu.conf
/usr/bin/sudo -n /usr/bin/systemctl daemon-reload
/usr/bin/sudo -n /opt/agent-deck/bin/agent-deck-feishu check-abi >/dev/null

run_service() {
  /usr/bin/sudo -n -u "$service_user" /usr/bin/env -i \
    HOME="$service_home" PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    XDG_RUNTIME_DIR="$runtime_root" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_root/bus" \
    /usr/bin/env --chdir="$service_home" "$@"
}
if [[ "$topology" == relay ]]; then
  run_service /usr/bin/podman pull --quiet "$input_image" >/dev/null
  image_tag="${relay_repository}:${version}"
  run_service /usr/bin/podman build --pull=never \
    --build-arg "RELAY_RUNTIME_IMAGE=$input_image" \
    --tag "$image_tag" \
    --file "$release_root/deploy/linux/relay/Containerfile" \
    "$release_root" >/dev/null
  image_digest="$(run_service /usr/bin/podman image inspect --format '{{.Digest}}' -- "$image_tag")"
  [[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Relay build 未返回有效 digest'
  image_reference="${relay_repository}@${image_digest}"
else
  run_service /usr/bin/podman pull --quiet "$input_image" >/dev/null
  image_digest="$(run_service /usr/bin/podman image inspect --format '{{.Digest}}' -- "$input_image")"
  [[ "$input_image" == *@"$image_digest" ]] || fail 'Full image digest 检查失败'
  image_reference="$input_image"
fi

echo "AGENT_DECK_IMAGE=$image_reference"
