#!/usr/bin/env bash
set -euo pipefail
unset BASH_ENV ENV LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS
PATH=/usr/bin:/bin
export PATH

fail() {
  echo "远程验收证据安装失败：$*" >&2
  exit 1
}

archive=${1:-}
topology=${2:-}
service_user=${3:-}
service_uid=${4:-}
service_home=${5:-}
instance_id=${6:-}
generation=${7:-}
version=${8:-}
[[ "$archive" =~ ^/tmp/agent-deck-evidence-[a-z0-9-]+\.tgz$ && -f "$archive" && ! -L "$archive" ]] || fail 'evidence archive 无效'
[[ "$topology" == relay || "$topology" == full ]] || fail 'topology 无效'
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'service user 无效'
[[ "$service_uid" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'service uid 无效'
[[ "$service_home" == /var/lib/agent-deck ]] || fail 'service home 无效'
[[ "$instance_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'instance id 无效'
[[ "$generation" =~ ^[1-9][0-9]{0,15}$ ]] || fail 'generation 无效'
[[ "$version" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'version 无效'
[[ "$(/usr/bin/id -u "$service_user")" == "$service_uid" ]] || fail 'service user/uid 不匹配'

evidence_root="$(/usr/bin/mktemp -d /tmp/agent-deck-evidence.XXXXXX)"
cleanup() {
  /bin/rm -rf -- "$evidence_root"
  /bin/rm -f -- "$archive"
}
trap cleanup EXIT
/usr/bin/tar -xzf "$archive" -C "$evidence_root" --no-same-owner --no-same-permissions
for name in legacy-egress legacy-quota exact-egress exact-quota; do
  [[ -f "$evidence_root/$name" && ! -L "$evidence_root/$name" ]] || fail "缺少 evidence 文件 $name"
done
[[ "$(/usr/bin/find "$evidence_root" -mindepth 1 -maxdepth 1 -type f | /usr/bin/wc -l)" == 4 ]] || fail 'evidence archive 包含多余文件'

service_group="$(/usr/bin/id -gn "$service_user")"
if [[ "$topology" == relay ]]; then
  legacy_root="/etc/agent-deck-relay/evidence/$instance_id"
  /usr/bin/sudo -n /usr/bin/install -d -o root -g root -m 0555 "$legacy_root"
  legacy_owner=root
  legacy_group=root
else
  legacy_root="$service_home/.config/agent-deck/instances/$instance_id"
  [[ -d "$legacy_root" && ! -L "$legacy_root" ]] || fail 'Full instance config 目录尚不存在'
  legacy_owner=$service_user
  legacy_group=$service_group
fi
exact_root="/etc/agent-deck-manager/evidence/$topology/$instance_id/${generation}-${version}"
/usr/bin/sudo -n /usr/bin/install -d -o root -g root -m 0555 \
  "/etc/agent-deck-manager/evidence/$topology/$instance_id" "$exact_root"

if [[ "$topology" == relay ]]; then
  legacy_egress=egress.env
  legacy_quota=quota.env
else
  legacy_egress=egress-policy.verified
  legacy_quota=volume-quota.verified
fi
/usr/bin/sudo -n /usr/bin/install -o "$legacy_owner" -g "$legacy_group" -m 0444 -T \
  "$evidence_root/legacy-egress" "$legacy_root/$legacy_egress"
/usr/bin/sudo -n /usr/bin/install -o "$legacy_owner" -g "$legacy_group" -m 0444 -T \
  "$evidence_root/legacy-quota" "$legacy_root/$legacy_quota"
/usr/bin/sudo -n /usr/bin/install -o root -g root -m 0444 -T \
  "$evidence_root/exact-egress" "$exact_root/egress.env"
/usr/bin/sudo -n /usr/bin/install -o root -g root -m 0444 -T \
  "$evidence_root/exact-quota" "$exact_root/quota.env"

echo 'EVIDENCE_INSTALL_OK'
