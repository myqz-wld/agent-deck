---
review_id: 3
reviewed_at: 2026-04-24
expired: false
skipped_expired: []
---

# REVIEW_3: Phase 4 N5 FTS5 落地双对抗（Opus 现场跑 SQL 抓出 #1 致命 broken SQL）

## 触发场景

CHANGELOG_22 落地 Phase 4 N5（FTS5 历史搜索）+ N4（migrations 单轨化）。N5 涉及 FTS5 schema、trigram tokenizer、external content 触发器、phrase 转义、search SQL 形态等多处技术选型，按 `~/.claude/CLAUDE.md`「决策对抗」节走异源双对抗 review。

实施时落地的代码 + 单测全过 + build inline 通，但单测只用 regex 比对 SQL 字符串没真跑 SQL —— 给「字符串测试遮蔽 broken SQL」留了口子。本轮对抗在 commit 前介入。

## 方法

**双对抗配对**（`~/.claude/CLAUDE.md`「决策对抗」节）：

- **Agent A**：Claude（`general-purpose` subagent，Opus 4.7 xhigh），任务「挑刺型 review，揪真盲点不复述代码」，列了 6 类盲点引导（FTS 触发器一致性 / trigram 边界 / SQL 形态 / vite ?raw / migration tx / 首启回填代价）
- **Agent B**：Codex CLI（gpt-5.4 xhigh，`codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh`，超时 600000ms），同 prompt 但更精简（只列文件路径 + 重点盲点，跳过历史 reviews/changelog/CLAUDE.md）

**实际执行**：

- Opus 现场用 sqlite3 CLI（3.43.2）做 EXPLAIN QUERY PLAN + 真跑 SQL 验证，约 20 分钟出 11 条
- Codex 跑 16+ 分钟仍在初步 prefetch 文件没出结论 → 按 CLAUDE.md「真卡了 TaskStop 中止」处理（Opus 一份独立 reviewer 已给出致命发现，足够先动手）。本轮属于「外部 Agent 不可用」降级到内对抗（Opus 异于 Claude Code 主会话本身仍属「不同 reasoning 路径」）

**范围**：N5 + N4 改动的 6 个文件 + 1 配套测试

```text
src/main/store/migrations/v005_fts.sql
src/main/store/migrations/index.ts
src/main/store/search-predicate.ts
src/main/store/search-predicate.test.ts
src/main/store/session-repo.ts
src/main/store/db.ts
src/main/vite-env.d.ts
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
src/main/store/db.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v005_fts.sql
src/main/store/search-predicate.test.ts
src/main/store/search-predicate.ts
src/main/store/session-repo.ts
src/main/vite-env.d.ts
```

**约束**：N4 是顺手活（只是把 db.ts 内联 SQL 拆到 migrations/，无 schema 变化），review 重点放 N5。

## 三态裁决结果

### ✅ 真问题（已修）

| # | 严重度 | 文件:行号 | 问题 | 修复 |
|---|---|---|---|---|
| #1 | **致命** | `search-predicate.ts:64,70` | `fts MATCH @kw_fts` 别名形态 SQLite parse fail（`no such column: fts`），整条 FTS 搜索路径**一调就抛**。Opus 用 sqlite3 CLI 现场跑出来；我的单测只 regex 比对字符串，从未真跑过 SQL，所以 `pnpm test` 绿但生产一搜就炸 | 改 `events_fts MATCH @kw_fts` / `summaries_fts MATCH @kw_fts`（用虚表名而非 alias）+ 新增 `scripts/verify-fts5.sh` 12 项真 SQL 集成校验（含 alias MATCH 的 regression guard） |
| #2 | HIGH | `search-predicate.ts:60-72` | `EXISTS (SELECT 1 FROM events_fts ... WHERE fts MATCH ... AND e.session_id = sessions.id)` 是相关子查询，query planner 把外层 sessions 做 SCAN + 每行重跑一次 FTS（CORRELATED SCALAR SUBQUERY）。Opus 用 EXPLAIN QUERY PLAN 实测：5000 sessions / 100k events / selective 关键词，EXISTS 形态 0.207s，IN+SELECT DISTINCT 形态 <0.001s（差 200×） | 改 `sessions.id IN (SELECT DISTINCT e.session_id FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE events_fts MATCH @kw_fts)`，让 planner 一次物化 FTS 命中的小集合 + SEARCH sessions PK |
| #3 | HIGH | `v005_fts.sql:48-51,62-65` | `events_au` / `summaries_au` 触发器无条件 fire。`sessionRepo.rename()` 跑 `UPDATE events SET session_id = ?` 改千条引用时，old.payload_json == new.payload_json 但仍走「INSERT 'delete' + INSERT new」白干 2N 次 FTS 操作，rename 慢 + WAL 膨胀 | 加 `WHEN old.payload_json IS NOT new.payload_json` 子句（summaries_au 同款 `WHEN old.content IS NOT new.content`）。SQLite IS NOT NULL-safe |
| #5 | MED | `v005_fts.sql:19,26` | trigram tokenizer 默认 `case_sensitive=0`（fetch sqlite.org/fts5.html 原文确认），原 `payload_json LIKE '%kw%'` 默认 BINARY collation 大小写敏感 → 行为悄悄反转：搜 `Foo` 现在会命中 `foo`/`FOO` | tokenize 改 `'trigram case_sensitive 1'` 维持原 LIKE BINARY 大小写敏感行为；如未来想反向需走 changelog 公告行为变更 |
| #10 | LOW | `db.ts:17-18` | v005 触发器从 trigger 写虚表（`INSERT INTO events_fts(events_fts, ...) VALUES('delete', ...)`）依赖 `trusted_schema=ON`。better-sqlite3 11.x 编译时默认 ON 不影响生产，但若未来 binding 改默认或谁加 `pragma trusted_schema=OFF`，v005 立刻迁移 fail（macOS 系统 sqlite3 CLI 默认 OFF 已实测复现） | db.ts:initDb 显式 `db.pragma('trusted_schema = ON')` + 一行注释解释依赖 |
| #11 | LOW | `db.ts:21-31` | `MIGRATIONS.filter().forEach` 保留数组顺序，若 `migrations/index.ts` 被人 cherry-pick 历史 hotfix 插错位置，DDL 依赖会乱套 | `.sort((a, b) => a.version - b.version)` 兜底，零成本 |

### ⚠️ 部分（暂不修，进 reviews 跟踪 / changelog 标注）

| # | 严重度 | 文件:行号 | 现场 | 当前定位 |
|---|---|---|---|---|
| #4 | MED | `v005_fts.sql:31-32` + `db.ts:24-32` | rebuild 在 migration tx 内同步阻塞 `initDb()`，10w+ events 时启动卡几秒到十几秒，没 splash UI；首次 OOM 被用户 kill 后下次启动还会**反复卡同一处** | **暂不拆**「DDL→commit→后台 rebuild」流程：当前用户库还小（事件数最多几千条），CHANGELOG_22 标注首启回填行为，未来若卡再优化（拆 v005 到 v005a/v005b + app_meta('fts5_seeded') 标志位 + listHistory 检测降级回 LIKE） |
| #6 | MED | `vitest.config.ts` | vitest 没装 vite plugin（current config `defineConfig from 'vitest/config'` 不带 transform pipeline），未来 test 文件 import `migrations/index.ts` 会爆 `Failed to resolve "./v005_fts.sql?raw"`。当前 search-predicate.test.ts 不踩 | **暂不补**：本轮搬集成测试都走 `scripts/verify-fts5.sh`（不依赖 vitest），未踩。若未来 vitest 真要 import migrations，再加 vite plugin 或抽 `getMigrationsList()` 工厂分环境注入 |
| #7 | LOW | `search-predicate.ts:65,71`（已删） | EXISTS 子查询里 `LIMIT 1` 是死代码（EXISTS 本身就在第一行匹配后短路） | 修 #2 时已顺手删（IN+DISTINCT 形态没 LIMIT 1） |
| #8 | LOW | `session-repo.ts:151` | `getDb().prepare(sql)` 每次 listHistory 都新建 prepared statement，better-sqlite3 没按 SQL 字符串自动缓存。HistoryPanel 已 debounce 用户输入是 bounded 浪费 | 暂不优化，未来若改流式搜索再 cache prepare（按「无关键词路径」/「含关键词路径」拆 2 prepared statement） |

### ❌ 自驳（Opus 自己 self-rebut，避免无效报警）

| 现场 | 现场评估 | 自驳依据 |
|---|---|---|
| "ON DELETE CASCADE 不会触发 events_ad，FTS 留 dangling" | 一开始被 sqlite.org/foreignkeys.html 一段措辞误导，但 Opus 写小 repro 跑 sqlite3 3.43.2：建 parents/events + ON DELETE CASCADE + AFTER DELETE 触发器，DELETE parents → events row 0 + fts row 0 → CASCADE **真的会**触发 AFTER DELETE 触发器 | verify-fts5.sh 测试 #10 进一步验证（complete schema + foreign_keys=ON 复现） |
| "trigram 对 `.ts` / `_id` 这种含标点的 substring 命中行为与 LIKE 不一致" | trigram tokenizer 原文「each contiguous sequence of three characters」，标点也参与 trigram。`.ts` 是 1 个 trigram，phrase `".ts"` 命中含 `.ts` 的文档，等价 `LIKE '%.ts%'`；`_id` 同理 | 行为一致，唯一变化是 case sensitive（已 #5 修） |
| "v005 在 tx 里 8 条 DDL，db.exec 失败会半残" | better-sqlite3 `db.exec` = sqlite3_exec，遇错立刻返回 throw；外层 `db.transaction()` 把 throw 转 ROLLBACK，整个 v005 + `pragma user_version = 5` 一起回滚。下次启动重跑无问题 | 无实际风险 |

## 修复（CHANGELOG_22 落地）

### CRITICAL

1. **search-predicate.ts:64,70** — `fts MATCH` → `events_fts MATCH` / `summaries_fts MATCH`（虚表名替代 alias），并补 `scripts/verify-fts5.sh` 12 项真 SQL 集成校验（含 alias MATCH 的 regression guard 一项）

### HIGH

2. **search-predicate.ts:60-72** — EXISTS+JOIN+LIMIT 1 → IN(SELECT DISTINCT)+JOIN，让 planner 物化 FTS 命中的小 session_id 集合
3. **v005_fts.sql:50-54,72-76** — `events_au` / `summaries_au` 加 `WHEN old.X IS NOT new.X` 防御 `sessionRepo.rename()` 白干

### MED

5. **v005_fts.sql:19,26** — tokenize 加 `case_sensitive 1` 维持原 LIKE BINARY 大小写敏感

### LOW

10. **db.ts:17-18** — 显式 `db.pragma('trusted_schema = ON')` 防御 binding 默认变化
11. **db.ts:21-31** — pending migrations 加 `.sort((a, b) => a.version - b.version)` 兜底数组乱序

## 集成校验

新增 `scripts/verify-fts5.sh`（`pnpm test:fts5`）：用 system sqlite3 CLI 在 :memory: 跑全套 V1-V5 migrations + 12 项真 SQL 检查（schema 应用 / title 命中 / FTS MATCH 表名形态 OK / case_sensitive=1 / INSERT/DELETE/UPDATE 触发器同步 / CASCADE DELETE→FTS 清理 / alias MATCH 仍被 sqlite3 拒绝的 regression guard）。不依赖 better-sqlite3 binding（electron 重编版本与本机 node 不兼容）、不依赖 vitest，能在 CI / 预 push 跑。

```
$ pnpm test:fts5
Using sqlite3 3.43.2
OK   schema applies cleanly
OK   title-only match (≥3 chars)
OK   events_fts MATCH parse OK + match correctness
OK   summaries_fts MATCH hits
OK   trigram case_sensitive=1 (大小写敏感, 维持原 LIKE BINARY 行为)
OK   trigram case_sensitive=1 (相同大小写命中)
OK   INSERT trigger 同步
OK   DELETE trigger 同步
OK   UPDATE WHEN 防御: rename 不破坏 FTS
OK   UPDATE WHEN 触发: payload 真改时 FTS 同步新值
OK   CASCADE DELETE 触发 events_ad → FTS 清理
OK   alias MATCH 仍被 sqlite3 拒绝（regression guard）: rejected as expected

All FTS5 integration checks passed (sqlite3 3.43.2).
```

## 关联 changelog

- [CHANGELOG_22.md](../changelog/CHANGELOG_22.md)：本次修复落地

## Agent 踩坑沉淀

本次 review 抓出**一条新模式化坑**值得记入 `.claude/conventions-tally.md`「Agent 踩坑候选」section：

- **「单测只 regex 匹配 SQL 字符串而不真跑」会让 broken SQL 蒙混过关**：N5 落地时 `search-predicate.test.ts` 13 项全过，但实际 SQL 在 sqlite3 一调就 parse fail，因为单测从未把生成的 SQL 灌进真 sqlite3 跑。修法：涉及 SQL fragment 构造的纯函数测试要配「真 SQL 集成测试脚本」（`scripts/verify-fts5.sh` 即此类），跑在 sqlite3 CLI 而非 vitest（绕过 better-sqlite3 binding 不可用问题）。下次类似遇到 grep + 读取 + 多次撞同类型再升级到 CLAUDE.md
