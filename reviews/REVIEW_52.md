---
review_id: 52
reviewed_at: 2026-05-21
expired: false
---

# REVIEW_52: codex SessionDetail 三 bug + ingest 写入侧 dedup 加固 — 6 ✅ HIGH/MED 全 land

## 触发场景

用户主动报 3 条 codex SessionDetail UX bug：

- **症状 A**: codex session ActivityFeed 工具调用重复显示 / 一个调用出现多行（"codex 是流式输出可能有些问题"）
- **症状 B**: 有些完成的工具调用不能点 ▸ 展开看结果
- **症状 C**: codex session 改动 tab 无效（看不到文件实际改动 — 显示空白 Monaco diff editor）

## 方法

**单轮 Bash 异构对抗**（user CLAUDE.md §决策对抗 §主路径 双 Bash 并发起外部 CLI）：

- **reviewer-claude**: Claude Opus 4.7, `claude --model opus --permission-mode default --disallowedTools 'Edit,MultiEdit,Write,NotebookEdit,ExitPlanMode' -p`，timeout 600000
- **reviewer-codex**: Codex gpt-5.5 xhigh, `codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh -C <repo> -o $OUT`，timeout 600000

两个 CLI 进程独立并发，stdout 落到 `/private/tmp/claude-503/.../tasks/<bg-id>.output`，主 agent 三态裁决。

**注**: reviewer-claude 首轮 `--permission-mode plan + -p` 撞 ExitPlanMode 非交互模式拒绝路径 → finding 正文被吞 → 仅留 404B 一行总结。重试改 `--permission-mode default + --disallowedTools ExitPlanMode` 后正常拿到 17KB 完整 finding。reviewer-codex 一次成功（trace 含 sqlite3 :memory: 实测命令与结果，铁证 partial conflict target WHERE 必须重复 + ON CONFLICT 配 partial unique index 实跑通过）。

**范围**:

| 文件 | 行号 | 改动类型 |
|---|---|---|
| `src/main/store/event-repo.ts` | 6-34 / 36-43 | 新建 extractToolUseId helper + UPSERT insert + listForSession SQL secondary key |
| `src/renderer/stores/session-store.ts` | 317-324 | setRecentEvents 加 dedup |
| `src/main/store/migrations/v022_events_tool_use_dedup.sql` | new | partial UNIQUE INDEX + 历史回填 + ROW_NUMBER cleanup |
| `src/main/store/migrations/index.ts` | 21-22 / 63-65 | 注册 v022 |
| `src/renderer/components/activity-feed/rows/tool-row.tsx` | 195-253 | 移除 disabled 守门 + 三态分支 + ▸/▾ 总是显示 |
| `src/renderer/components/diff/renderers/TextDiffRenderer.tsx` | 全文 | isMetaOnly 兜底卡片 + metadata.source 分支 |

**focus** (9 维度，prompt 详 `/tmp/reviewer-prompt-codex-activityfeed.md`):

1. A1 dedup 边界（toolUseId 缺失 / 非 string / 空字符串）
2. A2 SQL 安全性（DELETE 子查询 / partial UNIQUE INDEX / ON CONFLICT 与 partial index 兼容性 / RETURNING 支持）
3. A2 ingest pipeline 影响（UPSERT 后 lastInsertRowid vs RETURNING）
4. A2 子表 reference（events.id 是否被外键引用）
5. A2 历史数据兼容（toolUseId camelCase 字段名稳定）
6. B1 a11y / 性能（imageRead 边界）
7. C1 isMetaOnly 边界（误命中 claude 端 / claude SDK Write 异常 payload）
8. 三处修法独立性（A1/A2/B1/C1 解耦）
9. 写入路径其他点遗漂（除 event-repo.ts insert 外是否还有其他路径写 events 表）

## 三态裁决清单

### ✅ 真问题（必修）— 6 条全 land

#### F1 — A2 partial UNIQUE INDEX 与 ON CONFLICT target 必须重复 WHERE 子句

- **双方独立** ✅: reviewer-claude HIGH-1 ↔ reviewer-codex HIGH-2
- **铁证**: reviewer-codex 实跑 `sqlite3 :memory:` 不带 WHERE 子句 → `Parse error: Parse error near line 9: unsafe use of virtual table "events_fts"` + 升级版 `PRAGMA trusted_schema=ON; ON CONFLICT(...)` 不带 WHERE 报 `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`；带 WHERE 跑通显示 dedup 结果 `id=2 kind=tool-use-start tool_use_id=u`。reviewer-claude 引用 SQLite 3.49.2 `lang_upsert.html` 文档明定「If the conflict target is a UNIQUE index with a partial index expression, then the WHERE clause of the partial UNIQUE index must be repeated in the conflict-target」。
- **修法**: `event-repo.ts` insert UPSERT：
  ```sql
  INSERT INTO events (...) VALUES (...)
  ON CONFLICT(session_id, kind, tool_use_id)
    WHERE kind = 'tool-use-start' AND tool_use_id IS NOT NULL
    DO UPDATE SET payload_json = excluded.payload_json, ts = excluded.ts
  RETURNING id
  ```
- **副作用**: WHERE 子句字节级与 v022 partial UNIQUE INDEX 的 WHERE 一致；改 SQL 时双处必须同步

#### F2 — `migrations/index.ts` 没注册 v022

- **reviewer-codex 单方提出 + 实测铁证**: HIGH-1 grep `migrations/index.ts` line 14 + 14-34 import 列表 + 42-64 MIGRATIONS array 当前最大 v021，新增 v022 SQL 文件不会被 db.ts initDb() 数组循环执行 → event-repo.ts 写 tool_use_id 列直接打到不存在的列 → 启动崩
- **修法**: `migrations/index.ts` 加 `import v022 from './v022_events_tool_use_dedup.sql?raw';` + push `{ version: 22, name: 'events_tool_use_dedup', sql: v022 }`
- **属内功失误**: plan 草稿仅说"新建 v022 SQL"，没说"同步注册"，reviewer-codex 抓住

#### F3 — listForSession SQL 缺 secondary key id DESC

- **双方独立** ✅: reviewer-claude MED-1 ↔ reviewer-codex MED-3
- **证据**: `event-repo.ts:39 SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?` 同毫秒 ts 行 SQLite 顺序未定义。codex item.updated 推几条同 toolUseId tool-use-start，Date.now() 在 ms 边界可能撞同毫秒 → A1 dedup「首条即最新」语义破坏（拿到 aggregated_output 较短的旧 payload）
- **修法**: `event-repo.ts:36-43` SQL 改 `ORDER BY ts DESC, id DESC`。id AUTOINCREMENT 单调递增 → 同毫秒按 id DESC 取最大即最晚插入

#### F4 — A2 落地后 FTS5 trigger 对每条 codex item.updated 全文重建 trigram 索引

- **reviewer-claude 单方提出 + 文档铁证**: HIGH-3 引 v005_fts.sql events_au trigger + SQLite lang_upsert.html「The DO UPDATE clause behaves as if the corresponding columns were updated using an UPDATE statement, including firing of triggers」
- **风险**: codex 长 command（30 秒推 50+ 条 item.updated）每条 fire trigger → 每次 trigram 全删全建。reviewer-claude 自 ack「trigger 单行 rebuild 量级小」是潜在不是必然
- **裁决**: 用户拍板走 **A 仅 ack 风险**（最低改动 + 实际症状未现，先把 A1/A2/B1/C1 落地解决用户报告的真问题）。本 review §已知风险节明确监控点：v022 落地后观察 FTS5 trigger fire 频率与主进程延时；codex 长 command 高频 item.updated 场景如出现搜索/插入卡顿，回头加 B（UPSERT WHERE excluded.ts > events.ts）或 C（trigger WHEN 收窄）

#### F5 — C1 isMetaOnly 兜底卡片硬读 metadata.changeKind/patchStatus → claude Write 异常 payload 显 undefined

- **reviewer-claude 单方提出 + 现场实证**: HIGH-4 cat `src/main/adapters/claude-code/translate.ts:248-266` Write 工具 emit metadata 是 `{ source: 'Write' }`，没有 codex 的 changeKind/patchStatus 字段；如果 SDK 罕见 content=null → before=null after=null 命中 isMetaOnly 分支 → 渲染 `[changeKind: undefined] [patchStatus: undefined]` 迷惑用户
- **修法**: TextDiffRenderer.tsx isMetaOnly 分支按 metadata.source 分流：
  - `isCodex = md.source === 'codex'` → 显 changeKind chip + patchStatus chip + codex 提示文案「不提供 diff 文本，git diff 看实际差异」
  - 否则 → 显「文件信息缺失（source: <X>）」通用文案

#### F6 — DELETE 历史冗余用 MAX(id) 不是按 ts 排序

- **reviewer-codex 单方提出 + 实测铁证**: MED-1 sqlite3 :memory: 插入同 toolUseId 三行 `id=1 ts=300, id=2 ts=100, id=3 ts=200`，MAX(id) 选 id=3 ts=200，不是 UI 排序语义里的最新 ts（ts=300 那条 id=1）。codex 重连乱序场景下 id 与 ts 顺序不一致
- **修法**: v022 SQL DELETE 用窗口函数 ROW_NUMBER OVER：
  ```sql
  DELETE FROM events WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY session_id, tool_use_id
        ORDER BY ts DESC, id DESC
      ) AS rn
      FROM events
      WHERE kind = 'tool-use-start' AND tool_use_id IS NOT NULL
    )
    WHERE rn > 1
  );
  ```
  ORDER BY ts DESC, id DESC 与 listForSession SQL F3 修法字节级对齐 — UI 拉历史首条 == migration 保留首条

### ❌ 反驳 / N/A — 3 条

reviewer-claude 三处担心是 plan 全文未读出的保守提醒（HIGH-5 自标 caveat：plan 在 `/tmp/`，sandbox 之外读不到），plan 实际已覆盖：

- **F10**（claude HIGH-2）: A2 INSERT VALUES 缺 tool_use_id 列 — plan 已写完整 INSERT 含 tool_use_id 5 个 `?`
- **F11**（claude MED-3）: B1 line 246 hasContent 守门未同步去掉 — plan 已写 `{open && (hasContent ? <pre> : <div>)}` 三态分支
- **F12**（claude MED-5）: C1 isNewFile 改造后 codex add 不显示 NEW 徽章 — codex 所有 file_change 都 before=null after=null 走 isMetaOnly 分支（不走 isNewFile）；HIGH-4 修法（按 source 分支兜底卡片）已涵盖 codex add 显示

### LOW-1 — v022 回填没过滤空字符串 / 非 string toolUseId（顺手修）

- **reviewer-codex LOW-1**: sqlite3 :memory: 实测 `{"toolUseId":""}` 回填为 `''`，`{"toolUseId":123}` 回填为 `'123'` 都进 dedup 路径
- **修法**: v022 UPDATE 加 `json_type(payload_json, '$.toolUseId') = 'text' AND json_extract(...) != ''` 守门，与 event-repo.ts extractToolUseId 守门字节对齐

## INFO（实证 / 确认）

| 编号 | 来源 | 内容 |
|---|---|---|
| INFO-1 | reviewer-claude / codex 共识 | bundled SQLite 3.49.2（`node_modules/better-sqlite3/deps/sqlite3/sqlite3.h`），UPSERT (3.24+) ✅、partial index (3.8+) ✅、RETURNING (3.35+) ✅、ROW_NUMBER (3.25+) ✅ 全支持 |
| INFO-2 | reviewer-codex 实证 | `events.id` 没被业务子表外键引用（grep `event_id\|REFERENCES events\|FOREIGN KEY.*events` 仅命中 events 自身索引；file_changes 通过 session_id 关联）→ DELETE 历史 id 缺口安全 |
| INFO-3 | reviewer-claude 实证 | 项目内已有 `RETURNING *` 用法（agent-deck-message-repo.ts:326）+ `ON CONFLICT(id) DO UPDATE` 用法（session-repo/core-crud.ts:54、v010_agent_deck_teams.sql）→ 这两特性在 better-sqlite3 11.10.0 路径上已实证可用 |
| INFO-4 | reviewer-claude 实证 | `RECENT_LIMIT = 200`（不是 prompt 推测的 30，已升级），A1 read-side dedup 保护范围足够 |
| INFO-5 | reviewer-codex 实证 | `eventRepo.insert` 唯一调用方 manager-ingest-pipeline.ts:164，无第二条写入路径绕过 dedup |
| INFO-6 | reviewer-codex 实证 | `fileChangeRepo.insert` 唯一调用方 manager-ingest-pipeline.ts:186，C1 fix 不影响其他 file_changes 写入 |

## 修法清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/main/store/event-repo.ts` | F3: listForSession SQL 加 `ORDER BY ts DESC, id DESC` secondary key（防同毫秒乱序）；A2: extractToolUseId helper（typeof string + 非空守门，与 session-store.ts upsertEvent 字节对齐） + insert 走 partial-WHERE UPSERT + RETURNING id（避免 lastInsertRowid 在 conflict 路径返 attempt rowid）；Row 加 tool_use_id 列 |
| 2 | `src/renderer/stores/session-store.ts` | A1: setRecentEvents 加 toolUseId dedup（与 upsertEvent line 98-115 同款语义；listForSession ORDER BY ts DESC, id DESC 后首条即最新） |
| 3 | `src/main/store/migrations/v022_events_tool_use_dedup.sql` | 新建：ALTER TABLE 加 tool_use_id + 类型守门 UPDATE 回填 + ROW_NUMBER OVER ORDER BY ts DESC, id DESC 历史 cleanup + partial UNIQUE INDEX(session_id, kind, tool_use_id) WHERE kind='tool-use-start' AND tool_use_id IS NOT NULL |
| 4 | `src/main/store/migrations/index.ts` | F2: import v022 + push `{ version: 22, name: 'events_tool_use_dedup', sql: v022 }` |
| 5 | `src/renderer/components/activity-feed/rows/tool-row.tsx` | B1: 移除 disabled={!hasContent}；line 246 改三态分支（hasContent ? `<pre>` : `<div>` 显「(无输出 · status / exit）」；line 204 总是 ▸/▾（去 `·` 占位） |
| 6 | `src/renderer/components/diff/renderers/TextDiffRenderer.tsx` | C1+F5: 加 isMetaOnly 分支（before==null && after==null）→ 不挂 Monaco，按 metadata.source=='codex' 分流：codex 显 changeKind/patchStatus chip + 提示文案；其他 source 显「文件信息缺失」；isNewFile 改 `before==null && after!=null`（防 codex meta-only 误标 NEW） |

## 已知风险（监控点）

- **F4 FTS5 trigger 副作用 ack**: v022 落地 + 用户进 codex 长 command 高频 item.updated 场景（30 秒 npm test 推 50+ 条 update）后，观察主进程延时与 FTS5 搜索响应。如出现卡顿，回头补：
  - **B 选项（cheap）**: UPSERT 加 `WHERE excluded.ts > events.ts` 减少同毫秒 / 乱序场景的无效 update
  - **C 选项（根治）**: 改 v005_fts.sql events_au trigger WHEN 加 `old.kind != 'tool-use-start' OR old.tool_use_id IS NULL` 跳 UPSERT 路径，代价 tool-use-start 的 aggregated_output 不进 FTS5 搜索（tool-use-end 同 toolUseId 收尾 payload 仍进 FTS5，关键词搜索仍命中）

## 验证手段

| 项 | 验证 |
|---|---|
| typecheck | ✅ `pnpm typecheck` 全过（Node + Web 两 tsconfig） |
| build | ✅ `pnpm build` 全过（main + preload + renderer 三 bundle，v022 SQL 通过 vite `?raw` import 内联进 main bundle） |
| A 实测 | 待用户实测：cold start codex session 跑长命令，切换会话回来 ActivityFeed 应只 1 行 tool-use-start |
| A2 migration 实测 | 待用户实测：启动应用观察 v022 migration log；DB 内同 toolUseId 重复条目应被清理 |
| B 实测 | 待用户实测：codex 跑 `mkdir foo`，ToolEndRow 应能点 ▸ 展开看「(无输出 · exit 0)」 |
| C 实测 | 待用户实测：codex session 改文件后切到「改动」tab，应看到文件分组 + changeKind chip + 兜底卡片说明（不再空白 Monaco） |
| SQL 行级正确性 | ✅ reviewer-codex sqlite3 :memory: 实跑 ON CONFLICT + partial unique index + RETURNING + ROW_NUMBER 全套通过 |

`heterogeneous_dual_completed: true`
