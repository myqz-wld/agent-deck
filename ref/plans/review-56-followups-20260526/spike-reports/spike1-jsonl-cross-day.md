# spike1 — recoverer.ts jsonl 跨日 false miss 实测

> **对应 follow-up**: REVIEW_56 §F2 codex MED-1 (Batch A R2) / plan §C 类 F2 row
>
> **runner**: `spike1-jsonl-cross-day.mjs`
> **log**: `spike1-jsonl-cross-day.log`
> **算法 SSOT**: `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:465-487`
> **执行时间**: 2026-05-26 (Phase 1 Step 3)

## 动机

REVIEW_56 §F2 codex MED-1 提出 "recoverer.ts jsonl 跨日 false miss" 假设:
- 跨日 + 二次 fresh fallback 罕见 race
- 修法 (a) 持久化 `cli_session_started_at` 字段 (v026 migration) / (b) fallback 递归扫 `~/.codex/sessions/**/-<threadId>.jsonl`
- 留 spike 实测 fs 开销决定方向

**plan F2 row 描述偏差(spike 顺手发现)**:
- plan 写"`<YYYY-MM-DD>/-<threadId>.jsonl` 跨日子目录场景"
- **实际真路径**:`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<threadId>.jsonl`(三级嵌套,详 recoverer.ts:451-453 jsdoc)

**关键已知事实**(spike 前 read recoverer.ts L465-487 算法体确认):

```js
for (const dayOffset of [0, -1, 1]) {
  // scan <sessions>/<YYYY>/<MM>/<DD>/ 找 endsWith `-${threadId}.jsonl`
}
```

**算法已扫 ±1 day**(覆盖时区边界 / startedAt 与 codex 实际写 jsonl 跨日的边角)。所以 REVIEW_56 §F2 关切的"跨日 false miss"实际只发生在跨 **≥ 2 days** 场景。

## 实测假设

1. **case 0**:`startedAt` 与 jsonl 落盘**同日** → ✅ true match(typical 99% case)
2. **case 1/2**:`startedAt` 与 jsonl 落盘**跨 1 day** → ±1 day fallback 应 catch
3. **case 3/4**:`startedAt` 与 jsonl 落盘**跨 2 days** → 算法 false miss(只扫 0/-1/+1)
4. **case 5**:`startedAt = D 23:59:50 (local)` jsonl 在 D+1(UTC 时区跨日边界)→ ±1 day catch

## 实测命令

```bash
zsh -i -l -c "node spike1-jsonl-cross-day.mjs 2>&1 | tee spike1-jsonl-cross-day.log"
```

详 `spike1-jsonl-cross-day.mjs`(纯 Node mini-runner,不依赖 worktree TS 编译;算法本地复制保持一致)。

## 实测结果

```
=== spike1: jsonl 跨日 false miss 实测 ===

case 0 (startedAt same day as jsonl):                       ✅ true MATCH
case 1 (startedAt D-1, jsonl D):                            ✅ true MATCH (±1 day fallback caught)
case 2 (startedAt D+1, jsonl D):                            ✅ true MATCH (±1 day fallback caught)
case 3 (startedAt D-2, jsonl D):                            ❌ false MISS — algo only covers ±1 day
case 4 (startedAt D+2, jsonl D):                            ❌ false MISS — algo only covers ±1 day
case 5 (startedAt local 23:59:50 D, jsonl D+1 — UTC tz edge):✅ true MATCH (±1 day caught)

=== fs.readdir latency benchmark (3 day scan = 3x readdir) ===
small day  (10 files/day):    0.020ms/call
medium day (100 files/day):   0.062ms/call
busy day   (1000 files/day):  0.523ms/call

=== recursive fs scan alternative (plan F2 修法 b 候选) ===
Planted tree: 2y × 6m × 30d × 5f/day = 1800 total files
recursive scan (1800 files):                              0.052ms/call
±1 day algo (wrong startedAt, returns false):             0.007ms/call
```

## 结论

**实测结论**:
1. **±1 day 算法 cover 99%+ 场景** ✅:case 0/1/2/5 全 caught,包括 UTC 时区跨日边界
2. **跨 ≥ 2 days false miss 真发生** ❌:case 3/4 实测 miss,但触发场景需 startedAt 与 codex 写 jsonl 时刻**真差 ≥ 2 days**(典型场景差几秒,需 application crash 大量延迟 / 错误 startedAt persist 等异常)
3. **fs 开销实测 < 1ms** ⚡:busy day 1000 files/day 0.523ms;递归扫 1800 files 0.052ms;wrong startedAt fast-path 0.007ms。**fs 不是性能 blocker** — 修法 (b) 递归扫 fallback 完全可接受
4. **修法 (a) 持久化 `cli_session_started_at` 字段 v026 migration overkill**:既然 fs 开销 < 1ms,递归扫 fallback 比 schema 改简单得多(no migration / no test fixture rewrite),修法 (b) 优于 (a)

**False miss 后果回顾**(recoverer.ts:299-318 注释):
- jsonl 真不在 / false miss → 走 fresh thread fallback
- 用户失 codex 对话历史 + 误导
- 但**应用层** events / file_changes / summaries 子表保留(CHANGELOG_28 同款机制)— UX 退化但不灾难性数据丢失

## 候选决策

### 选项 A — fix:加 fallback 递归扫 fs 兜底(推荐)

- ±1 day fast path 保留(99%+ 命中)
- ±1 day miss 后**再走递归扫 sessionsRoot 找 endsWith `-<threadId>.jsonl`** 兜底
- 实测 fs 开销 < 1ms (1800 files),real-world 即使 100k+ files 也估 ~3ms
- 修法侵入小:`defaultCodexResumeJsonlExists` 末尾加 fallback 递归扫,test fixture 不动
- F2 final status:**✅ HIGH → 修(spike 证实跨 ≥ 2 day false miss 真存在,递归扫兜底可消除)**

### 选项 B — dismiss:±1 day 已 cover 99%+,跨 ≥ 2 day 概率太低不值修

- typical 场景 startedAt 与 jsonl 落盘差几秒,差 ≥ 2 day 需 abnormal scenario(application crash 长延迟 / 错误 startedAt persist)
- false miss 后果:用户失对话历史(应用层子表保留)+ fresh thread fallback,UX 退化非灾难
- 修法 acknowledge concept-level 残留风险,REVIEW_57 标 `❓ → ❌ ±1 day partial coverage,跨 ≥ 2 day false miss 残留风险接受`
- F2 final status:**❌ dismiss(±1 day 已 partial cover,跨 ≥ 2 day 罕见 race 接受)**

### 选项 C — 大手术:持久化 `cli_session_started_at` 字段 v026 migration

- v026 schema migration + sessions 表加 cli_session_started_at 列 + recoverer 用该列代替 sessionRepo.startedAt
- spike 已证 fs 开销不是 blocker,**这条路 overkill 不推荐**

## 残留风险(若选 A)

- 递归扫 fallback 命中后 jsonl 文件名匹配 `endsWith(-<threadId>.jsonl)` 仍依赖 codex CLI 写 jsonl naming convention 不变(若 CLI 改名规则需同步)
- 极端场景:用户 codex sessions 总量超 100k 文件 → 递归扫 latency 升至 ~3ms;仍 < 10ms 阈值可接受

## 残留风险(若选 B)

- abnormal scenario(crash + restart + startedAt persist 跨 ≥ 2 day) → 用户失对话历史
- 应用层 events / file_changes / summaries 子表保留,但 UX 退化(用户感知 reviewer-codex / hand-off 后失记忆)

## 待 lead 决策

按 plan §用户授权 RFC 决策(2026-05-26):**spike 实测结论需 user confirm**。决策选项 A/B/C 三选一,推荐 A (fix 路径)。
