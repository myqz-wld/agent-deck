#!/usr/bin/env bash
# Advisory pre-commit reminder for non-final project plans.
# Install from the repository root:
#   bash scripts/plan-archive-reminder-pre-commit.sh --install

set -euo pipefail

hook_block_start="# project-engineering-foundation plan archive reminder start"

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

install_hook() {
  local root git_dir hook_dir hook_path tmp

  root="$(repo_root)"
  if ! git_dir="$(git -C "$root" rev-parse --git-dir 2>/dev/null)"; then
    echo "plan archive reminder: run --install from inside a Git worktree" >&2
    exit 1
  fi

  case "$git_dir" in
    /*) hook_dir="$git_dir/hooks" ;;
    *) hook_dir="$root/$git_dir/hooks" ;;
  esac

  hook_path="$hook_dir/pre-commit"
  mkdir -p "$hook_dir"

  if [ -f "$hook_path" ] && grep -Fq "$hook_block_start" "$hook_path"; then
    chmod +x "$hook_path"
    echo "plan archive reminder already installed in $hook_path"
    return
  fi

  if [ ! -f "$hook_path" ]; then
    printf '#!/usr/bin/env bash\n\n' > "$hook_path"
  elif ! head -n 1 "$hook_path" | grep -q '^#!'; then
    tmp="${hook_path}.tmp.$$"
    {
      printf '#!/usr/bin/env bash\n\n'
      cat "$hook_path"
    } > "$tmp"
    mv "$tmp" "$hook_path"
  fi

  cat >> "$hook_path" <<'HOOK'

# project-engineering-foundation plan archive reminder start
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
reminder="$repo_root/scripts/plan-archive-reminder-pre-commit.sh"
if [ -x "$reminder" ]; then
  "$reminder" || true
elif [ -f "$reminder" ]; then
  bash "$reminder" || true
fi
# project-engineering-foundation plan archive reminder end
HOOK

  chmod +x "$hook_path"
  echo "installed plan archive reminder in $hook_path"
}

check_plan_workspace() {
  local root plan_dir count shown_count extra_count

  root="$(repo_root)"
  plan_dir="$root/.ref/plans"
  [ -d "$plan_dir" ] || return 0

  count="$(
    find "$plan_dir" -type f \
      ! -name '.DS_Store' \
      ! -name '.gitkeep' \
      ! -name 'INDEX.md' \
      -print 2>/dev/null \
      | wc -l \
      | tr -d '[:space:]'
  )"
  [ "$count" -gt 0 ] || return 0

  echo >&2
  echo "Plan archive reminder: non-final plan files are still present." >&2
  echo "Review whether these should be archived to ref/plans/ and listed in ref/plans/INDEX.md." >&2

  find "$plan_dir" -type f \
    ! -name '.DS_Store' \
    ! -name '.gitkeep' \
    ! -name 'INDEX.md' \
    -print 2>/dev/null \
    | sort \
    | awk 'NR <= 20' \
    | while IFS= read -r path; do
        printf '  - %s\n' "${path#"$root"/}" >&2
      done

  shown_count=20
  if [ "$count" -gt "$shown_count" ]; then
    extra_count=$((count - shown_count))
    echo "  ... and $extra_count more" >&2
  fi

  echo "This advisory hook does not block the commit." >&2
}

case "${1:-}" in
  --install)
    install_hook
    ;;
  "")
    check_plan_workspace
    ;;
  *)
    echo "Usage: $0 [--install]" >&2
    exit 2
    ;;
esac
