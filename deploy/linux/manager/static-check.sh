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
done < <(find "$source_root" -maxdepth 1 -type f -name '*.ts' \
  | sort)

grep -Fq 'readonly args: readonly string[]' "$source_root/types.ts" ||
  fail 'command port must expose argv arrays'
grep -Fq 'replaceFileAtomic(' "$source_root/types.ts" ||
  fail 'filesystem port must expose atomic replacement'
grep -Fq 'removeVolumeExact(' "$source_root/types.ts" ||
  fail 'Podman cleanup must remain identity-scoped'
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

if find "$repo_root/src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path "$source_root/*" -print0 |
  xargs -0 grep -El "(@hosts/instance-manager|hosts/instance-manager)"; then
  fail 'instance manager must remain unreachable from Core, sessions, clients, and gateways'
fi

echo 'instance manager static check: passed'
