#!/usr/bin/env bash
# File-level review expiry check. Run this as the first step before the next review.
# Use with the repository CLAUDE.md review-expiry rules.
# Run from the repository root.

set -euo pipefail

# ----------------------------------------------------------------------
# 1) List every REVIEW file, its review-scope (one relative path per line),
#    and the coverage baseline commit.
#    This script does not deduplicate to the latest review. If a file has
#    multiple reviews, it emits one row per REVIEW.
#    During expiry decisions, treat the latest REVIEW as the REVIEW file
#    with the largest X number.
# ----------------------------------------------------------------------
echo '## 1. Full file -> REVIEW x base commit mapping (same file in multiple reviews = multiple rows; use the largest X as latest)'
for f in ref/reviews/REVIEW_*.md; do
  [ -f "$f" ] || continue
  BASE=$(git log --diff-filter=A --format=%H -n 1 -- "$f")
  awk '/^```review-scope$/{s=1; next} /^```$/{s=0} s' "$f" \
    | while read p; do
        [ -n "$p" ] && echo -e "${p}\t${f}\t${BASE}"
      done
done

echo
echo '## 2. Single-file expiry check example (churn / commits / age)'
echo '## Usage: set file=... to the target file and BASE=... to the base commit from the mapping above'
cat <<'EOF'
file=src/main/foo.ts
BASE=<coverage baseline commit from the mapping above>

# Net churn (add+del)
git diff -w --numstat "$BASE" -- "$file" \
  | awk 'NF==3 {add+=$1; del+=$2} END {print "churn="add+del}'

# Distinct commit count
git log -w --format=%H "$BASE..HEAD" -- "$file" | sort -u | wc -l

# Coverage baseline author date
git log -1 --format=%cs "$BASE"
EOF

echo
cat <<'EOF'
## 3. Expiry rules (any match expires coverage)

- Net churn >= min(200 lines, 30% of current file LOC)
- Distinct commit count >= 3
- Coverage age >= 90 days and the file changed at least once during that period
- frontmatter expired: true (manual override)

## 4. Required minimum scope for this review

unreviewed files + expired reviewed files + scope_unknown files
Old reviews without parseable scope cannot exempt files.

## 5. Threshold changes (200 / 3 / 90)

Changing thresholds is a convention change; use the repository's configured review flow.
The expiry check itself is mechanical and does not need adversarial review.
EOF
