#!/usr/bin/env bash
# scripts/logger-check.sh
#
# Plan: runtime-logging-electron-log-20260529 §Step 3.5.2.5 (Round 2 fix R2-6 / Round 3 fix
# MED-Codex-2 + LOW-Claude-3 / Round 4 fix R4-MED-1 修订).
#
# 双重检查:
# 1. src/main + src/renderer 0 个 console.X 残留 (排除测试文件 / preload — preload 由
#    Step 3.2.6 spike (d) 选定方案处理). 命中真残留 / 新 PR 习惯 console.log 时立即拦.
# 2. logger.ts 模块独立性 (§不变量 8): 不依赖任何 @main / @shared / @renderer 业务模块.
#    确保 logger.ts 可在所有业务模块顶部 import 而不撞循环依赖.
#
# **依赖**: ripgrep (rg) — 不在系统 PATH 时 fail-fast (Round 4 fix R4-MED-1).
#   macOS: brew install ripgrep
#   Linux: apt install ripgrep / dnf install ripgrep
#
# **过滤规则** (Round 3 fix MED-Codex-2 + Round 4 fix R4-MED-1 妥协说明):
# 完美排除注释 / 字符串需 AST parsing (ts-morph) 复杂度高, 本 script 用 ripgrep -v 排除三种
# 典型 false-positive:
#   - 行首单行注释 `^\s*//`
#   - 单引号字符串内 `'.*console\.`
#   - JSDoc 块注释行 `^\s*\*` (R4-MED-1 修 typo 原 `'"\s*\*'` 是错的拦不住)
# 边角误漏: 如某行同时有代码 + 行尾注释 + 注释含 console.X 字面 → script 仍报残留. 配合
# Step 3.3 子步骤约定 "migrate 时同步把注释 / 字符串里的 console.log 等改成 logger / log call
# 措辞" 减少误报.

set -euo pipefail

# Round 4 fix R4-MED-1: 硬校验 ripgrep 可用, 避免 rg 缺失时 || true 吞错 false green
command -v rg >/dev/null || {
  echo "❌ ripgrep (rg) required but not found in PATH" >&2
  echo "   macOS: brew install ripgrep" >&2
  echo "   Linux: apt install ripgrep / dnf install ripgrep" >&2
  exit 1
}

# ─── 检查 1: 354 处全改 0 残留 ──────────────────────────────────────────
# 注: ripgrep 默认排除 .gitignore + node_modules. 用 --type-add 注册 tsx 类型 (rg 无内置 tsx
# type), -t ts -t tsx 一起扫 .ts + .tsx 文件.
matches=$(
  rg --type-add 'tsx:*.tsx' -t ts -t tsx 'console\.(log|warn|error|info|debug)\(' \
    src/main src/renderer \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.ts' \
    --glob '!src/preload/**' \
    | { rg -v '^\s*//' || true; } \
    | { rg -v "'.*console\." || true; } \
    | { rg -v '^\s*\*' || true; } \
    || true
)
if [ -n "$matches" ]; then
  echo "❌ console.* 残留 (应改成 scoped logger.X 调用):" >&2
  echo "$matches" >&2
  exit 1
fi

# ─── 检查 2: logger.ts 模块独立性 (§不变量 8) ──────────────────────────
# logger.ts 不应 import 任何 @main / @shared / @renderer 业务模块, 仅 electron + electron-log/
# main + node:* 三类基础依赖. 确保 logger.ts 可在所有业务模块顶部 import 不撞循环依赖.
logger_deps=$(
  rg "^import.*from '@(main|shared|renderer)/" src/main/utils/logger.ts || true
)
if [ -n "$logger_deps" ]; then
  echo "❌ logger.ts 不应 import 业务模块 (§不变量 8):" >&2
  echo "$logger_deps" >&2
  exit 1
fi

echo "✅ logger-check 通过 — src/main + src/renderer 0 console.X 残留, logger.ts 模块独立性 OK"
