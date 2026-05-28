#!/usr/bin/env bash
# File-level Review Expiry 自检 — agent 在「下一轮 review」第一步必跑
# 配合 resources/claude-config/CLAUDE.md §新项目工程地基 → 已审文件过期 节使用
# 在仓库根目录跑

set -euo pipefail

# ----------------------------------------------------------------------
# 1) 列出所有 REVIEW 及其 review-scope（一行一个相对路径）+ 覆盖基线 commit
#    注意：本脚本不去重取最新 — 同一文件多次审会输出多行（每个 REVIEW 一行）
#    后续判定时按「最新 REVIEW = REVIEW 文件名 X 编号最大」自行过滤
# ----------------------------------------------------------------------
echo '## 1. file → REVIEW × base commit 全量映射（同 file 多 review = 多行；按 X 编号最大取最新）'
for f in ref/reviews/REVIEW_*.md; do
  [ -f "$f" ] || continue
  BASE=$(git log --diff-filter=A --format=%H -n 1 -- "$f")
  awk '/^```review-scope$/{s=1; next} /^```$/{s=0} s' "$f" \
    | while read p; do
        [ -n "$p" ] && echo -e "${p}\t${f}\t${BASE}"
      done
done

echo
echo '## 2. 单文件过期判定示例（churn / commits / 时间）'
echo '## 用法：把 file=... 改成你要查的文件，BASE=... 改成上面映射里对应那行 base commit'
cat <<'EOF'
file=src/main/foo.ts
BASE=<上面映射里对应那行的覆盖基线 commit>

# 净 churn（add+del）
git diff -w --numstat "$BASE" -- "$file" \
  | awk 'NF==3 {add+=$1; del+=$2} END {print "churn="add+del}'

# distinct commit 数
git log -w --format=%H "$BASE..HEAD" -- "$file" | sort -u | wc -l

# 距覆盖天数（覆盖基线 commit 的 author date）
git log -1 --format=%cs "$BASE"
EOF

echo
cat <<'EOF'
## 3. 过期判定规则（任一命中即过期）

- 净 churn ≥ min(200 行, 当前文件 LOC 的 30%)
- distinct commit 数 ≥ 3
- 距覆盖 ≥ 90 天 且期间该文件至少有 1 次代码变更
- frontmatter expired: true（人工兜底）

## 4. 本轮 review 强制最小范围

未审 ∪ 已审过期 ∪ scope_unknown（解析不出 scope 的旧 review 不能拿来当豁免依据）

## 5. 阈值调整（200 / 3 / 90）

属约定升级，走「决策对抗」三态裁决；过期检查本身不走对抗（纯机械计算）
EOF
