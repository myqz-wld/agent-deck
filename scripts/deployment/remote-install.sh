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
cleanup() {
  /bin/rm -rf -- "$release_root"
  /bin/rm -f -- "$archive"
}
trap cleanup EXIT
/usr/bin/tar -xzf "$archive" -C "$release_root" --no-same-owner --no-same-permissions
if [[ -n "$(/usr/bin/find "$release_root" -type l -print -quit)" ]]; then
  fail 'release archive 包含符号链接'
fi
/bin/chmod -R u=rwX,go=rX "$release_root"

required=(
  build/linux-headless/instance-manager/index.mjs
  build/linux-headless/relay/index.mjs
  build/linux-headless/server-core-host-bridge/index.mjs
  resources/bin/agent-deck-instance-manager
  resources/bin/agent-deck-relay
  resources/bin/agent-deck-relay-health-gate
  resources/bin/agent-deck-full-bridge
  deploy/linux/full/agent-deck-full@.container.in
  deploy/linux/full/preflight.sh
  deploy/linux/relay/agent-deck-relay@.container
  deploy/linux/relay/preflight.sh
  deploy/linux/relay/Containerfile
  config/instance-manager.json
)
for relative_path in "${required[@]}"; do
  [[ -f "$release_root/$relative_path" && ! -L "$release_root/$relative_path" ]] || fail "release 缺少 $relative_path"
done

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
  /opt/agent-deck/share \
  /opt/agent-deck/share/full \
  /opt/agent-deck/share/relay
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
install_root_file "$release_root/resources/bin/agent-deck-instance-manager" \
  /opt/agent-deck/bin/agent-deck-instance-manager 0755
install_root_file "$release_root/resources/bin/agent-deck-relay" \
  /opt/agent-deck/bin/agent-deck-relay 0755
install_root_file "$release_root/resources/bin/agent-deck-relay-health-gate" \
  /opt/agent-deck/bin/agent-deck-relay-health-gate 0755
install_root_file "$release_root/resources/bin/agent-deck-full-bridge" \
  /opt/agent-deck/bin/agent-deck-full-bridge 0755
install_root_file "$release_root/deploy/linux/full/agent-deck-full@.container.in" \
  /opt/agent-deck/share/full/agent-deck-full@.container.in 0444
install_root_file "$release_root/deploy/linux/full/preflight.sh" \
  /opt/agent-deck/libexec/agent-deck-full-preflight 0555
install_root_file "$release_root/deploy/linux/relay/agent-deck-relay@.container" \
  /opt/agent-deck/share/relay/agent-deck-relay@.container 0444
install_root_file "$release_root/deploy/linux/relay/preflight.sh" \
  /opt/agent-deck/libexec/agent-deck-relay-preflight 0555
install_root_file "$release_root/config/instance-manager.json" \
  /etc/agent-deck-manager/config.json 0444

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
