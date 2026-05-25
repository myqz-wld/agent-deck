---
review_id: 54
reviewed_at: 2026-05-25
expired: false
---

# REVIEW_54: codex SessionDetail tool-use-end 重复 + 点不开 — 写入侧 + read-side 对称 dedup（v022 后续）

## 触发场景

用户报告:codex 会话详情页"工具调用（活动消息）还是有重复的情况，以及点不开"。"还是"暗示 REVIEW_52 已经修过类似问题但仍有遗漏。

## 根因（DB 实测铁证）

REVIEW_52 落地 v022 partial UNIQUE INDEX 后,DB 实测 `agent-deck.db`:

```
=== same toolUseId dup tool-use-start (post-dedup) ===
（无）✅ v022 修法生效

=== same toolUseId dup tool-use-end ===
session_id                            tool_use_id  n
------------------------------------  -----------  -
019e419e-1915-76e3-b4ba-04c1b86cf22e  item_5       2
019e438b-994f-7a10-b2c4-73f0d506f9ce  item_1       4
019e438b-994f-7a10-b2c4-73f0d506f9ce  item_10      4
019e438b-994f-7a10-b2c4-73f0d506f9ce  item_11      4
019e438b-994f-7a10-b2c4-73f0d506f9ce  item_14      4
019e438b-994f-7a10-b2c4-73f0d506f9ce  item_3       2
...（共 19 组 codex 会话同 toolUseId tool-use-end 行重复 2-4 次）
```

REVIEW_52 仅 dedup `tool-use-start`,**故意没修 `tool-use-end`**（注释：「终态事件，每对 start/end 独立行」）。但 codex thread restart/resume/重连路径下同 `item.id` 的 `item.completed` 会被重发多次,每次 emit 都是新 `tool-use-end` 新 DB 行,假设不成立。

### 渲染侧后果链

1. `event-repo.listForSession(sessionId, 200)` 拉 N 条同 toolUseId tool-use-end
2. `session-store.setRecentEvents` 旧版仅 dedup tool-use-start → 数组里同 toolUseId tool-use-end 仍 N 份
3. `ActivityFeed.recent.map((e) => <ActivityRow key={eventKey(e)} ... />)` 每条 event 渲染一个 li
4. `eventKey('tool-use-end:<toolUseId>')` 让 N 个 `<ActivityRow>` 共享同 React key
5. React key collision → 仅首个实例的 hooks state 保留,后续 li 的 button onClick 改的是同一份 `open` state,但 reconciliation 错乱让后续 li 不刷新 → **button 看起来点不动**

"重复"和"点不开"是同根因的两个症状（同 React key 多 li 共存）。

## 方法

**事后双对抗 review**（user 反问「你没对抗 review 吗」后补做，详 §双对抗补做 R1 节）:

- DB 实测：sqlite3 query 列出 19 组重复行（铁证根因）
- REVIEW_52 现成模板：v022 partial UNIQUE INDEX + UPSERT + ROW_NUMBER cleanup + setRecentEvents seen Set,本次仅对称扩到 tool-use-end（kind 字面替换）
- sqlite3 :memory: 实证 v025 全套 SQL（cleanup + UPSERT + UNIQUE 拦截 + start/end 互斥 + NULL 不参与 dedup,6 个用例全过）
- vitest 用例覆盖 sub-case A（partial index 就位 / start 索引不被推翻 / UNIQUE 冲突 / start+end 互斥 / NULL 不参与）+ sub-case B（v024→v025 跨版本 cleanup ts DESC, id DESC 顺序 / UPSERT row id 不变 / 5 类非合法 toolUseId 兜底）+ **sub-case C event-repo integration（双对抗补强）**（直接 import eventRepo.insert 跑真生产分支，覆盖 ternary kindLiteral 选择 / extractToolUseId 守门 / safeStringifyPayload 漂移）
- 双对抗 R1：reviewer-claude (Opus 4.7 xhigh, default mode + 禁 ExitPlanMode) + reviewer-codex (gpt-5.5 xhigh, read-only sandbox, anti-SKILL prefix) 并发对抗
- **测试触发方式**: better-sqlite3 ABI 守门 — 本机 dev binding（Electron 33 ABI v130）下 9 + sub-case C 用例全 skip。**本仓库无 .github/workflows/ CI 配置**，需手工触发跑：按 project CLAUDE.md §跑 vitest SQLite 真测前后必须保护 better-sqlite3 binding 节清理脚本切到 Node 20.18.3（Electron 33 ABI 匹配版本），跑 `pnpm exec vitest run src/main/store/__tests__/v025-migration.test.ts`，跑完按同节清理脚本恢复 binding（防 dev / .app 启动崩）

**范围**:

| 文件 | 位置（语义引用） | 改动 |
|---|---|---|
| `src/main/store/migrations/v025_events_tool_use_end_dedup.sql` | new | tool-use-end partial UNIQUE INDEX + ROW_NUMBER cleanup（v022 字节级对称） |
| `src/main/store/migrations/index.ts` | v025 import + MIGRATIONS array append | 注册 v025 |
| `src/main/store/event-repo.ts` | `insert` UPSERT 分支 | 扩 tool-use-start ∪ tool-use-end,ternary 选 WHERE kind 字面（无 SQL injection 风险） |
| `src/renderer/stores/session-store.ts` | `upsertEvent` + `setRecentEvents` action | 把 tool-use-end 加进 toolUseId dedup 路径,start/end 各自独立 seen set |
| `src/main/store/__tests__/v025-migration.test.ts` | new | sub-case A (5 用例) + sub-case B (4 用例) + sub-case C (6 用例 event-repo integration) |

## 三态裁决清单

### ✅ 真问题（必修）— 4 条全 land

#### F1 — DB 写入侧 tool-use-end 缺 partial UNIQUE INDEX（HIGH 数据冗余 + 渲染 bug 根因）

- **现场实证铁证**: DB 19 组 codex tool-use-end 重复行,REVIEW_52 v022 假设「每对独立终态」被 codex thread restart/resume 路径推翻
- **修法**: v025 migration 镜像 v022:
  ```sql
  CREATE UNIQUE INDEX events_tool_use_end_dedup
    ON events (session_id, kind, tool_use_id)
    WHERE kind = 'tool-use-end' AND tool_use_id IS NOT NULL;
  ```
  + ROW_NUMBER OVER ORDER BY ts DESC, id DESC 清历史冗余（与 v022 step 3 + listForSession SQL F3 修法字节级对齐 — UI 拉历史首条 == migration 保留首条）
- **副作用**: v022 partial UNIQUE INDEX 仍存在不被推翻（两 partial index kind 互斥）；tool_use_id 列已由 v022 创建不重复 ADD

#### F2 — event-repo.insert UPSERT 路径仅 tool-use-start（写入侧 dedup 不闭环）

- **修法**: insert 分支扩成 `kind === 'tool-use-start' || kind === 'tool-use-end'`,ON CONFLICT WHERE 子句必须与对应 partial UNIQUE INDEX 字节级一致（SQLite 3.49.2 lang_upsert.html 文档明定 + REVIEW_52 F1 实测铁证），用 ternary 选字面 `'tool-use-start'` / `'tool-use-end'`:
  ```ts
  const kindLiteral =
    event.kind === 'tool-use-start' ? "'tool-use-start'" : "'tool-use-end'";
  ```
- **SQL injection 风险**: 0。`event.kind` 是 schema-constrained literal union,narrow 后只剩两个 hardcoded 值,不接受任何外部输入字符串拼进 WHERE
- **副作用**: RETURNING id 在 UPSERT 路径返 victim row id（与 v022 INFO-1 reviewer-codex 实证同款）

#### F3 — store 层 setRecentEvents / upsertEvent 仅 dedup tool-use-start（read-side 不兜底）

- **修法**: 两处对称扩 tool-use-end,start/end 各自独立 seen set:
  ```ts
  const seen = e.kind === 'tool-use-start' ? seenStart : seenEnd;
  ```
- **为何独立 set**: 同 toolUseId 的 start + end 是不同 kind 配对（不能互相挤掉,每对仍独立两行）。eventKey 已是 `kind:toolUseId` 不动
- **副作用**: 与 DB 层 v025 UPSERT 双重护栏（写入侧 + 内存侧）。写入侧落地后历史 N 行也被 cleanup 删完,read-side dedup 是兜历史已写 N 行 + 防 React key collision 点不开 bug

#### F4 — 测试覆盖（sub-case A 5 + sub-case B 4 + sub-case C 6 = 15 用例）

- **sub-case A 语义**（partial UNIQUE INDEX 就位）:
  - A1: events_tool_use_end_dedup partial UNIQUE INDEX 就位 + WHERE 子句对齐
  - A2: v022 events_tool_use_start_dedup 仍存在不被推翻
  - A3: 同 (session, kind=tool-use-end, toolUseId) 第二次裸 INSERT 报 UNIQUE 错
  - A4: start + end 同 toolUseId 各自合法（两 partial index 互斥）
  - A5: tool_use_id IS NULL 不受 partial index 约束（任意多行）
- **sub-case B 语义**（v024→v025 跨版本升级 path）:
  - B1: cleanup 选 ts DESC, id DESC 首行（id 与 ts 顺序错位场景，验证非 MAX(id)）
  - B2: 升级后裸 INSERT 报 UNIQUE 错（应用层 UPSERT 由 event-repo 处理）
  - B3: UPSERT 替 payload+ts row id 不变（与 REVIEW_52 INFO-1 RETURNING id 语义一致）
  - B4: 历史 5 类非合法 toolUseId 行（空串 / number / object / boolean / 缺失字段）经 v022 LOW 守门均 NULL 列，不参与 dedup（**双对抗 R1 codex LOW-1 修法**：原仅 seed 空串 + null，未真覆盖 number / object / boolean → 现补齐 5 类）
- **sub-case C 语义**（event-repo integration，**双对抗 R1 codex LOW-2 修法**）:
  - C1: eventRepo.insert tool-use-start UPSERT 命中 conflict + row id 不变（ternary 选 'tool-use-start' 字面对齐 v022 partial index）
  - C2: eventRepo.insert tool-use-end UPSERT 命中 conflict + row id 不变（ternary 选 'tool-use-end' 字面对齐 v025 partial index）
  - C3: tool-use-start + tool-use-end 同 toolUseId 各占独立行（两 partial UNIQUE INDEX 互斥，ternary 选对 WHERE 字面）
  - C4: extractToolUseId 守门（缺失 / 空串 / 非 string toolUseId 走普通 INSERT 不 UPSERT）
  - C5: 其他 kind（message / file-changed）走普通 INSERT，不参与 UPSERT 路径
  - C6: safeStringifyPayload 复杂嵌套 payload 不抛错且 round-trip 一致
- **binding ABI 守门**: probe 不到 binding 时 15 用例全 skip（项目 CLAUDE.md 已记 better-sqlite3 ABI 踩坑）。本仓库**无 CI 配置**，触发跑见 §方法 节末尾说明（手工切 Node 20.18.3 + 清理脚本兜底）

### ❌ 反驳 / 不修 — 0 条

双对抗 R1 双方对核心修法（v025 SQL / event-repo UPSERT / store dedup）100% 共识，无 HIGH 单方独有 → 未触发反驳轮。

## 双对抗补做 R1（事后异构对抗）

**触发**: user 反问「你没对抗 review 吗」后 lead 补做（lead 误读 user "2" 为「省一轮」实际 user 选「跑对抗」）。

**reviewer 配对** (user CLAUDE.md §决策对抗 §主路径双 Bash 起异构外部 CLI):
- reviewer-claude: Claude Opus 4.7 xhigh, `--permission-mode default + --disallowedTools 'Edit,MultiEdit,Write,NotebookEdit,ExitPlanMode' + --add-dir /tmp -p`，timeout 600000
- reviewer-codex: Codex gpt-5.5 xhigh, `--sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh`，prompt 顶部加 anti-SKILL prefix，timeout 600000

**首轮失败 + 修法**（双方都失败但根因不同，记踩坑）:
- reviewer-claude 首轮 `--permission-mode plan + -p` 撞 ExitPlanMode 非交互模式拒绝路径吞 finding（与 REVIEW_52 §方法节同款踩坑，模板这个 bug 还没改）→ 改 `--permission-mode default + 禁 ExitPlanMode` 后正常
- reviewer-codex 首轮被 cwd 下 codex 本地 `~/.codex-default/skills/agent-deck/deep-review/SKILL.md` 描述触发词「review fix 多轮 / 再 review 一轮 / 双对抗 review」误激活,22k token 自检 SKILL 流程不出 finding 软退 → prompt 顶部加 anti-SKILL prefix 后正常

**裁决**:
- ✅ **双方独立 + 强冗余**:
  - F1 store 两独立 set 必要（claude INFO-4 反事实推理 + codex INFO-2 reads eventKey/ActivityFeed）— 已 land
  - F2 v025 SQL 主修法正确（claude HIGH=0 全过 + codex INFO-1 + sqlite3 实测）— 已 land
  - F3 ingest pipeline 无需改（claude F10 implicit + codex INFO-4 grep eventRepo.insert）— 已 land
  - F4 **CI 跑通未核实**（claude MED-1 ❓ + codex *未验证* + lead 现场 `ls .github` = 不存在）— 真问题 MED：原 REVIEW_54 §方法节「CI / 其他 Node 版本会跑」承诺空（仓库无 CI），已修为手工触发说明
- ✅ **单方 + 现场验证**（lead Read / Grep ≤ 5min 内验证）:
  - F5 **REVIEW_54 文档行号偏离**（claude MED-2 单方 + lead 现场 read 验证 upsertEvent 实际 104+ / setRecentEvents 实际 323+）— 真问题 MED，已改语义引用
  - F6 **测试覆盖声明偏满**（codex LOW-1 单方 + lead 现场 grep 验证 it 标题写「非 string」但只 seed 空串 + null）— 真问题 LOW，已补 5 类 seed (number / object / boolean / 空串 / 缺失)
  - F7 **runtime eventRepo.insert 未直测**（codex LOW-2 单方 + lead 现场 grep `eventRepo` 0 命中验证）— 真问题 LOW，已加 sub-case C 6 用例直 import eventRepo.insert 跑生产分支
  - F8 **FTS5 trigger 已被 WHEN 收窄**（codex INFO-3 单方 + lead 现场 read v005_fts.sql:60-61 验证 `WHEN old.payload_json IS NOT new.payload_json`）— 真信息：见 §已知风险节修订
- ✅ **已 ack 不修**（双方共识 / 不阻断）:
  - claude LOW-1 statement cache 项目惯例 / LOW-2 codex translate 端 dedup 取舍 / LOW-3 v025 step 1 noop 兜底
  - claude INFO-1 React 行为描述精细化 / INFO-3 漏测项 / INFO-5 partial INDEX 性能
- ❌ 反驳 0

`heterogeneous_dual_completed: true`

## 验证

- `pnpm typecheck` ✅
- sqlite3 :memory: 6 用例实证 ✅（cleanup 选 id=2 not MAX(id)=3 / UPSERT row id 不变 / start+end 互斥 / NULL 不参与 / UNIQUE 拦截裸 INSERT / start 索引不被推翻）
- vitest skip 15 用例（5 A + 4 B + 6 C，binding ABI 不匹配 dev binding，project CLAUDE.md 已记踩坑，守门 skip 不污染 dev binding）
- 双对抗 R1 ✅（reviewer-claude + reviewer-codex 100% 共识 0 HIGH，详 §双对抗补做 R1 节）

## 已知风险（修订自 REVIEW_52 §F4 ack）

**FTS5 trigger 副作用比 REVIEW_52 当时 ack 还小**（双对抗 R1 codex INFO-3 新发现 + lead 现场 read v005_fts.sql:60-65 实证）:

```sql
-- v005_fts.sql:60-61
CREATE TRIGGER events_au AFTER UPDATE ON events
WHEN old.payload_json IS NOT new.payload_json
BEGIN
  INSERT INTO events_fts(events_fts, rowid, payload_json) VALUES('delete', old.id, old.payload_json);
  INSERT INTO events_fts(rowid, payload_json) VALUES (new.id, new.payload_json);
END;
```

WHEN 守门含义：UPSERT DO UPDATE SET payload_json + ts 时仅 payload 真变才 fire trigger。
- **tool-use-end 重发同款 item.completed**（v025 主场景）：payload 完全一样 → trigger **不 fire** → FTS 零重建（与 REVIEW_52 F4 当时假设的「全部触发 FTS」相反）
- **tool-use-start item.updated 增量推**（v022 主场景）：aggregated_output 不断增长 payload 真变 → trigger fire 重建 FTS（这是 REVIEW_52 F4 真正担心的场景，监控点保留）

**REVIEW_52 F4 ack 修订**: 当时担心的「UPSERT 全部触发 FTS 重建」实际只覆盖 v022 tool-use-start 路径；v025 tool-use-end 路径因 codex thread restart 重发同款 payload 几乎不重建 FTS。**v025 引入的 FTS 副作用极小，不需新监控点**。

无其他新增风险。

## 不动项

- 不改 codex translate.ts 重发逻辑根因（codex thread restart 重发 item.completed 是 SDK 行为,应用层兜底已足够；双对抗 R1 claude LOW-2 / codex 未提反对）
- 不改 eventKey（已是 `kind:toolUseId`,本身正确,问题在数组多份）
- 不改 ToolEndRow button 交互（disabled 已在 REVIEW_52 B1 移除,本次 store dedup 后 React key collision 消失,点击行为自然恢复）
- 不主动跑 `pnpm rebuild` / 切 Node 版本跑测试（污染 dev binding 风险高,需用户授权；本仓库无 CI 配置 → 测试在 dev binding 下永远 skip，触发跑须手工，详 §方法 节末尾说明）
