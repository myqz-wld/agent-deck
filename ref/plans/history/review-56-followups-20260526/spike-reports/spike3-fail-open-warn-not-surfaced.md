# spike3 — archive-plan.ts fail-open warn 不 surface ok return.warnings 实测

> **对应 follow-up**: REVIEW_56 §F9 claude M2 (Batch B R1) / plan §C 类 F9 row
>
> **runner**: `spike3-fail-open-warn-not-surfaced.mjs`
> **log**: `spike3-fail-open-warn-not-surfaced.log`
> **算法 SSOT**:
>   - `src/main/agent-deck-mcp/tools/handlers/archive-plan.ts:95-142` `resolveCallerCwdDeps`
>   - `src/main/agent-deck-mcp/tools/handlers/archive-plan.ts:215-222` ok return.warnings
>   - `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:439` impl warnings 数组
>   - `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:165-181` 同款 fail-open helper(对称)
> **执行时间**: 2026-05-26 (Phase 1 Step 5)

## 动机

REVIEW_56 §F9 claude M2 (Batch B R1):
> archive-plan.ts fail-open warn 不 surface
> 修法: 重构 resolveCallerCwdDeps 签名返 `{deps, warnings}` 让 caller merge

REVIEW_56 §部分/未验证表 L157:
> 否,无 SQLite locked fixture 实测 | follow-up #9 (修法侵入大,纯优化)

**已知 P5 R1 修法**(spike 前 read code 确认):
- archive-plan.ts:101-103 注释:`P5 Round 1 reviewer-codex HIGH-2 (downgraded MED) 修法:DB 异常时 console.warn 让 operator 看到 fail-open 退化`
- archive-plan.ts:107-112 catch:`console.warn(...) + return {}`(退化 DEFAULT_DEPS)
- P5 修法只到 operator log,**没** surface 到 caller-visible ok return.warnings

**impl-side warnings 来源 grep evidence**(verified by grep `warnings:|warnings.push`):
- L439 `warnings: string[] = []` impl 内部数组
- L587 mainRepo-unrelated-dirty / L676/L684 cwd marker mismatch / L940 silent-override / L1052 spike-reports archive failed / L1215 clearCwdReleaseMarker failed
- handler 端 L222 `warnings: result.warnings` 直接透传 impl warnings, **不 merge handler 端 fail-open warn**

## 实测假设

1. **case 1**:sessionRepo.get throw (SQLite locked) → console.warn 输出,ok return.warnings **不含** fail-open
2. **case 2**:sessionRepo.get returns null (caller session not found) → silent return {},仅 impl info hint
3. **case 3**:sessionRepo.get OK (typical) → ok return.warnings impl info hint

## 实测命令

```bash
zsh -i -l -c "node spike3-fail-open-warn-not-surfaced.mjs 2>&1 | tee spike3-fail-open-warn-not-surfaced.log"
```

mini-runner 本地复刻 `resolveCallerCwdDeps` + mockable impl + mockable sessionRepo,模拟三 case。

## 实测结果

```
=== spike3: archive-plan fail-open warn 不 surface ok return.warnings ===

--- case 1: sessionRepo.get throw (SQLite locked simulation) ---
[archive-plan] sessionRepo.get(caller-1) threw — falling back to DEFAULT_DEPS (cwd=process.cwd, marker=null) SQLITE_BUSY: database is locked
ok return.warnings: [
  "info: using DEFAULT_DEPS cwd (process.cwd=/Users/apple/.../worktree)"
]
contains fail-open warning in ok return.warnings: ❌ NO (warning LOST — only on console.warn, not on caller-visible ok return.warnings)

--- case 2: sessionRepo.get returns null (caller session not found) ---
ok return.warnings: [
  "info: using DEFAULT_DEPS cwd (process.cwd=/Users/apple/.../worktree)"
]
caller knows fell back to DEFAULT_DEPS: ✅ YES (impl info hint) — but no explicit "session not found" warning either

--- case 3: sessionRepo.get OK (typical happy path) ---
ok return.warnings: [
  "info: using caller cwd /real/cwd"
]
```

## 结论

**实测结论**:
1. **F9 真问题 confirm** ✅:fail-open 退化 console.warn 只到 operator log,**caller-visible ok return.warnings 不含**
2. archive 走 DEFAULT_DEPS 仍**成功**(主仓库 git ops 走 mainRepo 不依赖 callerCwd),所以 P5 R1 修法 fail-open 设计取舍是合理的
3. **但** caller (lead / agent) 拿 ok return 看不到退化,可能 silent 错合(cwd precheck 降级走"无 marker"分支)
4. 顺手发现:`hand-off-session.ts:165-181` 同款 fail-open helper(对称结构)若选 A fix 需一并改

## 候选决策

### 选项 A — fix:重构签名 `{deps, warnings}` + handler merge(推荐)

- claude M2 原修法,trivial type change
- `resolveCallerCwdDeps` 签名从 `(callerSessionId): ArchivePlanDeps` 改 `(callerSessionId): { deps: ArchivePlanDeps; warnings: string[] }`
- handler 端 catch fail-open 时 `warnings.push('[archive-plan] sessionRepo.get threw — falling back to DEFAULT_DEPS')`
- handler L222 ok return:`warnings: [...callerCwdResult.warnings, ...result.warnings]`
- **对称改 `hand-off-session.ts:165-181`** 同款 fail-open helper(同款修法)
- 修法侵入小:2 file × 几行 type/merge 改 + 1-2 个回归 test
- F9 final status:**✅ HIGH → fix** (Phase 4 Step 20 实施)

### 选项 B — dismiss(可选)

- fail-open 设计取舍接受;console.warn operator log 已够
- archive_plan 收口成功率优先 > caller-visible 退化 hint(P5 R1 设计意图)
- REVIEW_57 标 `❓ → ❌ dismiss — fail-open 设计取舍接受,console.warn operator log 充足`
- F9 final status:**❌ dismiss**

### 选项 C — 中间路径:只 archive-plan.ts 改不动 hand-off-session.ts(scope 小)

- archive_plan 是关键收口动作 silent 退化风险高于普通 helper
- hand_off_session 退化风险较低(hand off 单 baton)
- 修法 scope 减半,但破坏对称
- 不推荐(对称破坏维护成本)

## 残留风险(若选 A)

- caller 看到 fail-open warning 后是否会有正确决策?(应是 ack + 自检 sessions 表 + retry archive_plan)
- 修法侵入 hand-off-session.ts:165-181 同款 helper 涉及现有 hand_off test 可能需 fixture 同步

## 残留风险(若选 B)

- caller silent 不知 fail-open 退化,生产环境 SQLite locked 偶发时 archive 走 DEFAULT_DEPS.cwd=process.cwd(主进程 cwd,可能不是真 caller cwd),archive 走 wrong mainRepo 风险(虽然 mainRepo git ops 限定 blast radius,但 plan frontmatter 状态 update / spike-reports/ mv 仍可能撞错位置)

## 待 lead 决策

按 plan §用户授权 RFC 决策(2026-05-26):**spike 实测结论需 user confirm**。决策 A/B/C 三选一,推荐 A (fix 路径) — caller silent 不知退化风险 vs trivial 修法 + 对称 hand-off-session.ts 同款 helper。
