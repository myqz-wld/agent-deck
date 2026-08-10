#!/usr/bin/env bash
set -euo pipefail

manager_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$manager_dir/../../.." && pwd)"
source_root="$repo_root/src/hosts/instance-manager"

fail() {
  echo "instance manager static check: $*" >&2
  exit 1
}

production_count="$(find "$source_root" -maxdepth 1 -type f -name '*.ts' \
  ! -name '*.test.ts' ! -name 'test-fixtures.ts' ! -name 'fake-filesystem.ts' | wc -l | tr -d ' ')"
((production_count > 0)) || fail 'production sources are missing'

if find "$source_root" -maxdepth 1 -type f -name '*.ts' \
  ! -name '*.test.ts' ! -name 'test-fixtures.ts' ! -name 'fake-filesystem.ts' -print0 |
  xargs -0 grep -En "from ['\"]node:(fs|fs/promises|child_process|cluster|net|worker_threads)['\"]"; then
  fail 'host filesystem/process access must remain behind injected ports'
fi

if find "$source_root" -maxdepth 1 -type f -name '*.ts' \
  ! -name '*.test.ts' ! -name 'test-fixtures.ts' ! -name 'fake-filesystem.ts' -print0 |
  xargs -0 grep -En "(execSync|spawnSync|execFileSync|shell:[[:space:]]*true|['\"]-c['\"])"; then
  fail 'shell strings and synchronous process execution are forbidden'
fi

while IFS= read -r file; do
  lines="$(wc -l < "$file" | tr -d ' ')"
  ((lines < 500)) || fail "source/test file exceeds 499 lines: ${file#$repo_root/}"
done < <(find "$source_root" -type f -name '*.ts' \
  | sort)

adapter_root="$source_root/adapters"
for required in \
  bounded-command.ts flock-lease.ts linux-filesystem.ts podman-rootless.ts production.ts systemd-user.ts; do
  [[ -f "$adapter_root/$required" ]] || fail "missing production Linux host adapter: $required"
done
[[ -f "$source_root/entrypoint.ts" && -f "$source_root/cli-config.ts" ]] ||
  fail 'instance manager command entrypoint is missing'
grep -Fq "'describe'" "$source_root/entrypoint.ts" ||
  fail 'deployment state command is missing'
grep -Fq 'readPrivateJsonFile' "$source_root/entrypoint.ts" ||
  fail 'instance manager command must read bounded private JSON files'
manager_wrapper="$repo_root/resources/bin/agent-deck-instance-manager"
bash -n "$manager_wrapper"
grep -Fq '/usr/bin/node /opt/agent-deck/linux-headless/instance-manager/index.mjs' "$manager_wrapper" ||
  fail 'instance manager wrapper must use the fixed packaged Node entrypoint'
grep -Fq 'O_NOFOLLOW' "$adapter_root/linux-filesystem.ts" ||
  fail 'production filesystem adapter must reject symlink leaf traversal'
grep -Fq '/proc/self/fd' "$adapter_root/linux-filesystem.ts" ||
  fail 'production filesystem adapter must use descriptor-relative Linux paths'
grep -Fq 'shell: false' "$adapter_root/bounded-command.ts" ||
  fail 'production command runner must remain argv-only'
grep -Fq "child.kill('SIGTERM')" "$adapter_root/bounded-command.ts" ||
  fail 'production command runner must have a SIGTERM phase'
grep -Fq "child.kill('SIGKILL')" "$adapter_root/bounded-command.ts" ||
  fail 'production command runner must have a SIGKILL phase'
grep -Fq 'finalExitWaitMs' "$adapter_root/bounded-command.ts" ||
  fail 'production command runner must have a final bounded exit wait'
for injection in LD_PRELOAD LD_LIBRARY_PATH NODE_OPTIONS BASH_ENV ENV; do
  grep -Fq "'$injection'" "$adapter_root/bounded-command.ts" ||
    fail "production command runner must explicitly reject $injection"
done
grep -Fq "'/proc/self/fd/3'" "$adapter_root/flock-lease.ts" ||
  fail 'host locks must remain bound to an inherited descriptor and parent pipe'
grep -Fq "['--user', 'daemon-reload']" "$adapter_root/systemd-user.ts" ||
  fail 'systemd adapter must target the user manager only'
grep -Fq 'security.rootless !== true' "$adapter_root/podman-rootless.ts" ||
  fail 'Podman adapter must fail closed unless rootless is proven'
if grep -Eq 'new LinuxDescriptorFileSystem\(options|testOnlyDirectPaths:|platform:' \
  "$adapter_root/production.ts"; then
  fail 'production composition must not expose platform or direct-path test bypasses'
fi
if grep -Eq 'options\.(systemd|podman)\?\.environment' "$adapter_root/production.ts"; then
  fail 'production systemd/Podman environments must not be caller-overridable'
fi

full_key="$repo_root/deploy/linux/full/authorized-client-key-options.txt"
for surface in desktop-full feishu-session-console; do
  grep -Fq "command=\"/opt/agent-deck/bin/agent-deck-full-bridge --instance INSTANCE_ID --credential CREDENTIAL_ID --surface $surface\"" "$full_key" ||
    fail "Full SSH key must dispatch through the exact host Podman bridge for $surface"
done
if grep -Fq '/run/agent-deck/' "$full_key"; then
  fail 'Full SSH key must not treat the container named-volume socket as a host path'
fi
for label in \
  'Label=io.agent-deck.instance=%i' \
  'Label=io.agent-deck.topology=full' \
  'Label=io.agent-deck.managed-by=agent-deck-instance-manager'; do
  grep -Fqx "$label" "$repo_root/deploy/linux/full/agent-deck-full@.container.in" ||
    fail "Full container identity label is missing: $label"
done

grep -Fq 'readonly args: readonly string[]' "$source_root/types.ts" ||
  fail 'command port must expose argv arrays'
grep -Fq 'replaceFileAtomic(' "$source_root/types.ts" ||
  fail 'filesystem port must expose atomic replacement'
grep -Fq 'removeVolumeExact(' "$source_root/types.ts" ||
  fail 'Podman cleanup must remain identity-scoped'
grep -Fq 'resolveVolumeDataPathExact(' "$source_root/types.ts" ||
  fail 'Full config installation must resolve an exact fenced state-volume data path'
grep -Fq 'volumeIdentity(inspected.CreatedAt, mountpoint)' "$adapter_root/podman-rootless.ts" ||
  fail 'Podman volume data paths must be bound to a stable opaque identity'
grep -Fq 'installFullRuntimeConfig(' "$source_root/create.ts" ||
  fail 'Full create must install the runtime config consumed inside the state volume'
grep -Fq 'installFullRuntimeConfig(' "$source_root/change.ts" ||
  fail 'Full upgrade and rollback must install the runtime config consumed by the container'
grep -Fq 'verifyFullRuntimeConfig(' "$source_root/lifecycle.ts" ||
  fail 'Full start must verify the state-volume runtime config digest'
grep -Fq 'verifyFullRuntimeConfig(' "$source_root/recovery.ts" ||
  fail 'Full recovery must verify the state-volume runtime config digest'
grep -Fq 'waitForHealthyContainer(' "$source_root/lifecycle.ts" ||
  fail 'instance start must poll the exact container health contract'
grep -Fq 'waitForHealthyContainer(' "$source_root/change.ts" ||
  fail 'instance cutover must poll the exact container health contract'
grep -Fq 'captureTreeExact(' "$source_root/types.ts" ||
  fail 'filesystem port must expose exact descriptor-style tree snapshots'
grep -Fq 'readonly leases: HostInstanceLeasePort' "$source_root/types.ts" ||
  fail 'cross-process instance locks must remain injected and mandatory'
grep -Fq 'export interface HostInstanceLock' "$source_root/types.ts" ||
  fail 'host instance lock ownership handle is missing'
if grep -Eq '(expiresAtMs|leaseDurationMs|staleOwnerRecoveryProven)' "$source_root/types.ts" "$source_root/manager.ts"; then
  fail 'host instance locks must not expire or permit time-based takeover'
fi
grep -Fq 'quarantine(lock: unknown' "$source_root/types.ts" ||
  fail 'malformed host lock handles must have a containment path'
grep -Fq 'operation journal checksum mismatch' "$source_root/journal.ts" ||
  fail 'durable operation journals must remain checksummed'
grep -Fq 'cutover evidence changed after validation' "$source_root/evidence.ts" ||
  fail 'cutover evidence must be revalidated immediately before use'

bash "$repo_root/deploy/linux/full/preflight.sh" --template \
  "$repo_root/deploy/linux/full/agent-deck-full@.container.in"
bash "$repo_root/deploy/linux/relay/preflight.sh" --quadlet \
  "$repo_root/deploy/linux/relay/agent-deck-relay@.container" --static-only >/dev/null

relay_runtime_success='relay preflight: runtime identity, health scheduler, and external egress/quota acceptance gates passed'
grep -Fq "echo \"$relay_runtime_success\"" "$repo_root/deploy/linux/relay/preflight.sh" ||
  fail 'Relay runtime preflight success output is missing'
grep -Fq "'$relay_runtime_success\\n'" "$source_root/preflight.ts" ||
  fail 'instance manager Relay runtime success contract drifted from the preflight'
grep -Fq "'$relay_runtime_success\\n'" "$source_root/test-fixtures.ts" ||
  fail 'instance manager Relay runtime test fixture drifted from the preflight'

if find "$repo_root/src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path "$source_root/*" -print0 |
  xargs -0 grep -El "(@hosts/instance-manager|hosts/instance-manager)"; then
  fail 'instance manager must remain unreachable from Core, sessions, clients, and gateways'
fi

echo 'instance manager static check: passed'
