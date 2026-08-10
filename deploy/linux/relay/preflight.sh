#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: preflight.sh --quadlet PATH [--static-only] [--instance ID --state-dir PATH --config-file PATH --control-dir PATH --egress-verification PATH --quota-verification PATH]" >&2
}

quadlet_path=""
instance_id=""
state_dir=""
config_file=""
control_dir=""
egress_verification=""
quota_verification=""
static_only=0

while (($# > 0)); do
  case "$1" in
    --quadlet) quadlet_path="${2:-}"; shift 2 ;;
    --instance) instance_id="${2:-}"; shift 2 ;;
    --state-dir) state_dir="${2:-}"; shift 2 ;;
    --config-file) config_file="${2:-}"; shift 2 ;;
    --control-dir) control_dir="${2:-}"; shift 2 ;;
    --egress-verification) egress_verification="${2:-}"; shift 2 ;;
    --quota-verification) quota_verification="${2:-}"; shift 2 ;;
    --static-only) static_only=1; shift ;;
    *) usage; exit 64 ;;
  esac
done

if [[ -z "$quadlet_path" || ! -f "$quadlet_path" || -L "$quadlet_path" ]]; then
  echo "relay preflight: --quadlet must name a regular non-symlink file" >&2
  exit 65
fi
if [[ -n "$instance_id" && ! "$instance_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "relay preflight: --instance must be a 1-63 byte lowercase Linux label" >&2
  exit 65
fi
quadlet_name="$(basename "$quadlet_path")"
if ((static_only == 1)) && [[ -z "$instance_id" ]]; then
  expected_quadlet_name='agent-deck-relay@.container'
else
  if [[ -z "$instance_id" ]]; then
    echo "relay preflight: runtime checks require --instance" >&2
    exit 65
  fi
  expected_quadlet_name="agent-deck-relay@${instance_id}.container"
fi
if [[ "$quadlet_name" != "$expected_quadlet_name" ]]; then
  echo "relay preflight: Quadlet filename must be $expected_quadlet_name" >&2
  exit 65
fi

if ! awk '
  function allowed(section, key) {
    if (section == "Unit")
      return key == "Description" || key == "After" || key == "Wants"
    if (section == "Container")
      return key == "Image" || key == "ContainerName" || key == "Exec" ||
        key == "Network" || key == "NoNewPrivileges" || key == "ReadOnly" ||
        key == "DropCapability" || key == "User" || key == "UserNS" ||
        key == "Volume" || key == "Tmpfs" || key == "PodmanArgs" ||
        key == "HealthCmd" || key == "HealthInterval" ||
        key == "HealthTimeout" || key == "HealthRetries" ||
        key == "HealthStartPeriod" || key == "HealthOnFailure" ||
        key == "Notify"
    if (section == "Service")
      return key == "ExecStartPost" || key == "Restart" || key == "RestartSec" ||
        key == "TimeoutStopSec" ||
        key == "TimeoutStartSec" || key == "MemoryMax" ||
        key == "CPUQuota" || key == "TasksMax" ||
        key == "LimitNOFILE"
    if (section == "Install") return key == "WantedBy"
    return 0
  }
  function reject(message) {
    print "relay preflight: Quadlet directive audit failed: " message > "/dev/stderr"
    failed = 1
    exit 1
  }
  /^[[:space:]]*$/ || /^[[:space:]]*[#;]/ { next }
  /^\[[A-Za-z]+\]$/ {
    section = substr($0, 2, length($0) - 2)
    if (section != "Unit" && section != "Container" && section != "Service" && section != "Install")
      reject("unknown section " section)
    section_count[section]++
    if (section_count[section] != 1) reject("duplicate section " section)
    next
  }
  {
    if (section == "") reject("directive outside a section")
    separator = index($0, "=")
    if (separator <= 1) reject("malformed directive")
    key = substr($0, 1, separator - 1)
    if (key ~ /[[:space:]]/ || !allowed(section, key)) reject("forbidden " section "." key)
    identity = section SUBSEP key
    directive_count[identity]++
    if (key != "Volume" && directive_count[identity] != 1)
      reject("duplicate singleton " section "." key)
  }
  END {
    if (failed) exit 1
    if (section_count["Unit"] != 1 || section_count["Container"] != 1 ||
        section_count["Service"] != 1 || section_count["Install"] != 1)
      reject("missing required section")
    if (directive_count["Container" SUBSEP "Volume"] != 3)
      reject("exactly three scoped volumes are required")
  }
' "$quadlet_path"; then
  exit 66
fi

required_lines=(
  'Description=Agent Deck relay-only instance %i'
  'After=network-online.target'
  'Wants=network-online.target'
  'ContainerName=agent-deck-relay-%i'
  'Exec=serve --instance %i --config /etc/agent-deck-relay/%i/config.json --state /var/lib/agent-deck-relay/%i --control-socket /run/agent-deck-relay/%i/control.sock'
  'Network=slirp4netns:allow_host_loopback=false'
  'NoNewPrivileges=true'
  'ReadOnly=true'
  'DropCapability=all'
  'User=%U:%G'
  'UserNS=keep-id'
  'Volume=%h/.config/agent-deck-relay/%i/config.json:/etc/agent-deck-relay/%i/config.json:ro,Z'
  'Volume=%h/.local/share/agent-deck-relay/%i:/var/lib/agent-deck-relay/%i:Z'
  'Volume=%t/agent-deck-relay/%i:/run/agent-deck-relay/%i:Z'
  'Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=32m'
  'PodmanArgs=--pids-limit=256 --memory=512m --cpus=1.0'
  'HealthCmd=["/opt/agent-deck/bin/agent-deck-relay","health","--socket","/run/agent-deck-relay/%i/control.sock"]'
  'HealthInterval=10s'
  'HealthTimeout=3s'
  'HealthRetries=3'
  'HealthStartPeriod=30s'
  'HealthOnFailure=kill'
  'Notify=healthy'
  'ExecStartPost=/opt/agent-deck/bin/agent-deck-relay-health-gate --container agent-deck-relay-%i'
  'Restart=on-failure'
  'RestartSec=5s'
  'TimeoutStartSec=120s'
  'TimeoutStopSec=30s'
  'MemoryMax=512M'
  'CPUQuota=100%'
  'TasksMax=256'
  'LimitNOFILE=4096'
  'WantedBy=default.target'
)
for line in "${required_lines[@]}"; do
  if [[ "$(grep -Fxc -- "$line" "$quadlet_path")" != 1 ]]; then
    echo "relay preflight: missing or duplicated exact Quadlet setting: $line" >&2
    exit 67
  fi
done

if grep -Eqi '(PublishPort|ExposeHostPort|Device=|AddCapability=|privileged|\.sock:|Network=host|Volume=/)' "$quadlet_path"; then
  echo "relay preflight: privileged, broad-mount, host-network, port, and engine-socket directives are forbidden" >&2
  exit 67
fi

image_ref="$(sed -n 's/^Image=//p' "$quadlet_path")"
if [[ "$image_ref" == *'__REPLACE_'* ]]; then
  if ((static_only == 0)); then
    echo "relay preflight: replace the image digest placeholder before install" >&2
    exit 68
  fi
elif [[ ! "$image_ref" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "relay preflight: image must be pinned by sha256 digest" >&2
  exit 68
fi

if ((static_only == 1)); then
  echo "relay preflight: static exact-template checks passed; runtime gates remain unverified"
  exit 0
fi

runtime_uid="$(id -u)"
runtime_gid="$(id -g)"
if [[ "$runtime_uid" == 0 ]]; then
  echo "relay preflight: root execution is forbidden" >&2
  exit 69
fi
for command_name in realpath stat systemctl timeout; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "relay preflight: missing command: $command_name" >&2
    exit 69
  fi
done
health_gate='/opt/agent-deck/bin/agent-deck-relay-health-gate'
podman_executable='/usr/bin/podman'
for host_executable in "$health_gate" "$podman_executable"; do
  if [[ ! -f "$host_executable" || -L "$host_executable" ||
        "$(realpath -e -- "$host_executable")" != "$host_executable" ||
        "$(stat -c '%u' "$host_executable")" != 0 ||
        "$(stat -c '%a' "$host_executable")" != 755 || -w "$host_executable" ]]; then
    echo "relay preflight: host executable must be root-owned mode 0755 at $host_executable" >&2
    exit 69
  fi
done
if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
  echo "relay preflight: cgroup v2 is required" >&2
  exit 69
fi
if [[ "$($podman_executable info --format '{{.Host.Security.Rootless}}')" != true ]]; then
  echo "relay preflight: Podman must run rootless" >&2
  exit 69
fi
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "relay preflight: systemd user manager is unavailable" >&2
  exit 69
fi
if [[ "${XDG_RUNTIME_DIR:-}" != "/run/user/$runtime_uid" ]]; then
  echo "relay preflight: XDG_RUNTIME_DIR must be the service account systemd runtime directory" >&2
  exit 69
fi

verify_service_dir() {
  local label="$1" path="$2" expected="$3" mode="$4"
  if [[ -z "$path" || "$path" != "$expected" || ! -d "$path" || -L "$path" ]]; then
    echo "relay preflight: $label must be the exact non-symlink path $expected" >&2
    exit 70
  fi
  if [[ "$(realpath -e -- "$path")" != "$expected" ]]; then
    echo "relay preflight: $label normalization mismatch" >&2
    exit 70
  fi
  if [[ "$(stat -c '%u' "$path")" != "$runtime_uid" || "$(stat -c '%a' "$path")" != "$mode" ]]; then
    echo "relay preflight: $label must be service-account owned with mode $mode" >&2
    exit 70
  fi
}

expected_state_dir="$HOME/.local/share/agent-deck-relay/$instance_id"
expected_config_dir="$HOME/.config/agent-deck-relay/$instance_id"
expected_config_file="$expected_config_dir/config.json"
expected_control_dir="$XDG_RUNTIME_DIR/agent-deck-relay/$instance_id"
verify_service_dir "state directory" "$state_dir" "$expected_state_dir" 700
verify_service_dir "config directory" "$(dirname "$config_file")" "$expected_config_dir" 700
verify_service_dir "control directory" "$control_dir" "$expected_control_dir" 700

if [[ "$config_file" != "$expected_config_file" || ! -f "$config_file" || -L "$config_file" ]]; then
  echo "relay preflight: config must be the exact regular non-symlink per-instance file" >&2
  exit 70
fi
if [[ "$(realpath -e -- "$config_file")" != "$expected_config_file" ]]; then
  echo "relay preflight: config normalization mismatch" >&2
  exit 70
fi
if [[ "$(stat -c '%u' "$config_file")" != "$runtime_uid" || "$(stat -c '%a' "$config_file")" != 600 ]]; then
  echo "relay preflight: config must be service-account owned with mode 0600" >&2
  exit 70
fi
control_socket="$control_dir/control.sock"
if [[ -e "$control_socket" || -L "$control_socket" ]]; then
  echo "relay preflight: a pre-existing control socket would violate singleton startup" >&2
  exit 70
fi

verify_root_dir() {
  local label="$1" path="$2" expected="$3" mode="$4"
  if [[ "$path" != "$expected" || ! -d "$path" || -L "$path" || "$(realpath -e -- "$path")" != "$expected" ]]; then
    echo "relay preflight: $label path is not exact or contains symlink indirection" >&2
    exit 71
  fi
  if [[ "$(stat -c '%u' "$path")" != 0 || "$(stat -c '%a' "$path")" != "$mode" || -w "$path" ]]; then
    echo "relay preflight: $label must be root-owned with mode $mode" >&2
    exit 71
  fi
}

evidence_config_root="/etc/agent-deck-relay"
evidence_base="$evidence_config_root/evidence"
evidence_dir="$evidence_base/$instance_id"
verify_root_dir "evidence config root" "$evidence_config_root" "$evidence_config_root" 555
verify_root_dir "evidence base" "$evidence_base" "$evidence_base" 555
verify_root_dir "instance evidence directory" "$evidence_dir" "$evidence_dir" 555

verify_evidence_file() {
  local label="$1" path="$2" expected="$3"
  if [[ "$path" != "$expected" || ! -f "$path" || -L "$path" || "$(realpath -e -- "$path")" != "$expected" ]]; then
    echo "relay preflight: $label evidence must be the exact regular non-symlink file $expected" >&2
    exit 71
  fi
  if [[ "$(stat -c '%u' "$path")" != 0 || "$(stat -c '%a' "$path")" != 444 || -w "$path" ]]; then
    echo "relay preflight: $label evidence must be root-owned read-only mode 0444" >&2
    exit 71
  fi
}

verify_exact_evidence() {
  local label="$1" path="$2"
  shift 2
  if [[ "$(wc -l < "$path" | tr -d ' ')" != "$#" ]]; then
    echo "relay preflight: $label evidence contains missing, duplicate, or extra lines" >&2
    exit 71
  fi
  local evidence
  for evidence in "$@"; do
    if [[ "$(grep -Fxc -- "$evidence" "$path")" != 1 ]]; then
      echo "relay preflight: $label acceptance gate is unverified: $evidence" >&2
      exit 71
    fi
  done
}

verify_evidence_file "public-only egress" "$egress_verification" "$evidence_dir/egress.env"
verify_exact_evidence "public-only egress" "$egress_verification" \
  'schemaVersion=1' \
  "instanceId=$instance_id" \
  'publicOnlyEgressVerified=true' \
  'privateAndLinkLocalDenied=true' \
  'cloudMetadataDenied=true'

state_real="$(realpath -e -- "$state_dir")"
verify_evidence_file "state-volume quota" "$quota_verification" "$evidence_dir/quota.env"
verify_exact_evidence "state-volume quota" "$quota_verification" \
  'schemaVersion=1' \
  "instanceId=$instance_id" \
  "statePath=$state_real" \
  'stateQuotaEnforced=true' \
  'stateQuotaBytes=1073741824'

if ! "$podman_executable" image exists "$image_ref"; then
  echo "relay preflight: pinned Relay image must exist locally for the uid/volume probe" >&2
  exit 72
fi
probe_name=".agent-deck-preflight-$instance_id-$$"
probe_state="$state_dir/$probe_name"
probe_control="$control_dir/$probe_name"
health_probe_name="agent-deck-relay-preflight-$runtime_uid-$$"
if [[ -e "$probe_state" || -L "$probe_state" || -e "$probe_control" || -L "$probe_control" ]]; then
  echo "relay preflight: uid probe path collision" >&2
  exit 72
fi
if "$podman_executable" container exists "$health_probe_name"; then
  echo "relay preflight: health scheduler probe container collision" >&2
  exit 72
fi
cleanup_probe() {
  rm -f -- "$probe_state" "$probe_control"
  if "$podman_executable" container exists "$health_probe_name"; then
    "$podman_executable" stop --time 2 "$health_probe_name" >/dev/null 2>&1 || true
    if "$podman_executable" container exists "$health_probe_name"; then
      "$podman_executable" container rm --force "$health_probe_name" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup_probe EXIT

if ! timeout 60s "$podman_executable" run --rm \
  --network=none \
  --read-only \
  --userns=keep-id \
  --user "$runtime_uid:$runtime_gid" \
  --security-opt=no-new-privileges \
  --cap-drop=all \
  --pids-limit=32 \
  --memory=128m \
  --cpus=0.25 \
  -v "$state_dir:/probe/state:Z" \
  -v "$config_file:/probe/config.json:ro,Z" \
  -v "$control_dir:/probe/control:Z" \
  --entrypoint /usr/bin/node \
  "$image_ref" \
  -e '
    const fs = require("node:fs");
    const name = process.argv[1];
    fs.accessSync("/probe/config.json", fs.constants.R_OK);
    let writable = false;
    try { const fd = fs.openSync("/probe/config.json", "a"); fs.closeSync(fd); writable = true; } catch {}
    if (writable) throw new Error("config mount is writable");
    for (const directory of ["/probe/state", "/probe/control"])
      fs.writeFileSync(`${directory}/${name}`, "probe", { flag: "wx", mode: 0o600 });
  ' "$probe_name"; then
  echo "relay preflight: keep-id uid/config/state/control runtime probe failed" >&2
  exit 72
fi
for probe_file in "$probe_state" "$probe_control"; do
  if [[ ! -f "$probe_file" || -L "$probe_file" || "$(stat -c '%u' "$probe_file")" != "$runtime_uid" || "$(stat -c '%a' "$probe_file")" != 600 ]]; then
    echo "relay preflight: keep-id probe did not preserve service uid and mode 0600" >&2
    exit 72
  fi
done

if ! "$podman_executable" run --detach --rm \
  --name "$health_probe_name" \
  --network=slirp4netns:allow_host_loopback=false \
  --read-only \
  --userns=keep-id \
  --user "$runtime_uid:$runtime_gid" \
  --security-opt=no-new-privileges \
  --cap-drop=all \
  --pids-limit=32 \
  --memory=128m \
  --cpus=0.25 \
  --health-cmd=/usr/bin/true \
  --health-interval=1s \
  --health-timeout=1s \
  --health-retries=1 \
  --health-start-period=0s \
  --entrypoint=/usr/bin/node \
  "$image_ref" \
  -e 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 60_000);' \
  >/dev/null; then
  echo "relay preflight: Podman health scheduler probe failed to start" >&2
  exit 72
fi
if ! timeout 20s "$health_gate" --container "$health_probe_name"; then
  echo "relay preflight: Podman health scheduler did not advance the probe to healthy" >&2
  exit 72
fi
if [[ "$("$podman_executable" inspect --type container --format '{{.State.Health.Status}}' "$health_probe_name")" != healthy ]]; then
  echo "relay preflight: Podman health scheduler probe did not retain healthy state" >&2
  exit 72
fi
cleanup_probe
trap - EXIT

echo "relay preflight: runtime identity, health scheduler, and external egress/quota acceptance gates passed"
