#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "agent-deck full appliance preflight: $*" >&2
  exit 1
}

require_line() {
  local file=$1
  local line=$2
  grep -Fqx -- "$line" "$file" || fail "missing required line: $line"
}

validate_common() {
  local unit=$1
  [[ -f "$unit" ]] || fail "Quadlet file not found: $unit"
  require_line "$unit" 'ReadOnly=true'
  require_line "$unit" 'ReadOnlyTmpfs=false'
  require_line "$unit" 'NoNewPrivileges=true'
  require_line "$unit" 'DropCapability=all'
  require_line "$unit" 'UserNS=keep-id'
  require_line "$unit" 'HealthInterval=30s'
  require_line "$unit" 'HealthTimeout=5s'
  require_line "$unit" 'HealthRetries=3'
  require_line "$unit" 'HealthOnFailure=kill'
  require_line "$unit" 'Notify=healthy'
  require_line "$unit" 'Volume=agent-deck-%i-state:/var/lib/agent-deck:rw,nodev,nosuid'
  require_line "$unit" 'Volume=agent-deck-%i-workspace:/workspaces:rw,nodev,nosuid'
  require_line "$unit" 'Volume=agent-deck-%i-socket:/run/agent-deck:rw,nodev,nosuid,noexec'
  require_line "$unit" 'Volume=agent-deck-%i-browser:/var/lib/agent-deck-browser:rw,nodev,nosuid'
  require_line "$unit" 'Volume=agent-deck-%i-secrets:/run/secrets:ro,nodev,nosuid,noexec'
  require_line "$unit" 'ExecStartPre=/usr/bin/test -r %h/.config/agent-deck/instances/%i/egress-policy.verified'
  require_line "$unit" 'ExecStartPre=/usr/bin/test -r %h/.config/agent-deck/instances/%i/volume-quota.verified'

  grep -Eq '^Memory=[^[:space:]]+$' "$unit" || fail 'Memory limit is required'
  grep -Eq '^PidsLimit=[1-9][0-9]*$|^PidsLimit=@@PIDS_LIMIT@@$' "$unit" ||
    fail 'positive PID limit is required'
  grep -Eq '^PodmanArgs=.*--cpus=[^[:space:]]+.*--storage-opt=size=[^[:space:]]+' "$unit" ||
    fail 'CPU and rootfs storage limits are required'
  grep -Eq '^LogOpt=max-size=[^[:space:]]+$' "$unit" || fail 'bounded log size is required'
  grep -Eq '^Network=[^[:space:]]+$' "$unit" || fail 'an explicit private network is required'

  if grep -Eq '^(PublishPort|ExposeHostPort|AddDevice|AddCapability|EnvironmentHost)=' "$unit"; then
    fail 'published ports, devices, added capabilities, and host environment are forbidden'
  fi
  if grep -Eq '^Network=(host|container:)' "$unit"; then
    fail 'host or shared-container networking is forbidden'
  fi
  if grep -Eqi '(docker|podman|containerd)\.sock|^Volume=/:|^Volume=/(home|root|Users|dev)(/|:|$)' "$unit"; then
    fail 'host root/home/device/container-engine mounts are forbidden'
  fi
}

validate_template() {
  local unit=$1
  validate_common "$unit"
  require_line "$unit" 'Image=@@IMAGE_DIGEST@@'
  require_line "$unit" 'Network=@@VERIFIED_EGRESS_NETWORK@@'
}

validate_rendered() {
  local unit=$1
  validate_common "$unit"
  if grep -q '@@' "$unit"; then
    fail 'rendered Quadlet still contains template placeholders'
  fi
  grep -Eq '^Image=[^[:space:]@]+@sha256:[0-9a-f]{64}$' "$unit" ||
    fail 'image must be pinned by sha256 digest'
}

validate_host() {
  local unit=$1
  [[ "$(uname -s)" == 'Linux' ]] || fail 'host checks require a real Linux host'
  command -v podman >/dev/null 2>&1 || fail 'podman is required'
  [[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail 'cgroup v2 is required by rootless Quadlet'
  local service_user
  service_user=$(id -un)
  grep -Eq "^${service_user}:" /etc/subuid || fail "missing subordinate UID range for ${service_user}"
  grep -Eq "^${service_user}:" /etc/subgid || fail "missing subordinate GID range for ${service_user}"
  [[ "$(podman info --format '{{.Host.Security.Rootless}}')" == 'true' ]] ||
    fail 'podman must be rootless'
  [[ "$(podman info --format '{{.Host.CgroupsVersion}}')" == 'v2' ]] ||
    fail 'podman must report cgroup v2'
  [[ "${AGENT_DECK_EGRESS_ENFORCEMENT:-}" == 'verified-egress-gateway' ]] ||
    fail 'TODO gate: verified public DNS/HTTP(S)-only egress enforcement is required'
  [[ "${AGENT_DECK_VOLUME_QUOTA_READY:-}" == 'verified' ]] ||
    fail 'TODO gate: state/workspace/browser volume quota enforcement is required'
  validate_rendered "$unit"
}

mode=${1:-}
unit=${2:-}
case "$mode" in
  --template) validate_template "$unit" ;;
  --rendered) validate_rendered "$unit" ;;
  --host) validate_host "$unit" ;;
  *) fail 'usage: preflight.sh --template|--rendered|--host QUADLET_FILE' ;;
esac
