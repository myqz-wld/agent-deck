# CHANGELOG_22: 双对抗架构评审 Phase 4 — N4 migrations 单轨化 + N5 FTS5 历史搜索（Opus 实跑 SQL 抓出 broken SQL 致命点）

## 概要

承接 CHANGELOG_21 的 Phase 1-3，本次按 plan 落地 Phase 4：N4 把 db.ts 内联 V1-V4 SQL 字符串拆到 `migrations/v00x_*.sql` 文件（vite `?raw` build 时内联到 main bundle），N5 新增 V5 FTS5 + trigram tokenizer 历史搜索（events_fts / summaries_fts external content + 触发器同步 + rebuild 回填），search-predicate.ts 拆出纯函数 + 13 项单测。

**实施后双对抗（Opus 4.7 xhigh）现场用 sqlite3 CLI 跑 SQL + EXPLAIN QUERY PLAN 抓出 1 致命 + 2 高 + 3 中低，最关键的是 `fts MATCH @kw_fts` 别名形态 SQLite parse fail（整条 FTS 路径一搜就抛），单测只 regex 比对字符串没跑真 SQL 完全漏掉**。已修 6 处真问题 + 新增 `scripts/verify-fts5.sh`（12 项真 SQL 集成校验，含 alias MATCH 的 regression guard），typecheck + 27 vitest + 12 FTS5 集成 + build 全过。

## 变更内容

### Phase 4 N4：migrations 单轨化（CHANGELOG_20 / N4）

- 把 db.ts 内联的 V1-V4 SQL 字符串（V1_INIT / V2_ADD_SOURCE / V3_SPLIT_ARCHIVE / V4_ADD_PERMISSION_MODE）拆到 `src/main/store/migrations/v002_sessions_source.sql` / `v003_split_archive_from_lifecycle.sql` / `v004_sessions_permission_mode.sql`（v001_init.sql 已存在且内容与 V1 一致 → 复用，不再是孤儿）
- 新增 `src/main/store/migrations/index.ts`：用 vite `?raw` import 把 sql 文件作为字符串内联到 main bundle，运行时不需要 fs.readFileSync，避免 dev/asar 路径分歧（CHANGELOG_15 ENOTDIR 教训）
- 新增 `src/main/vite-env.d.ts`：声明 `*?raw` 模块给 main 进程 tsc 用（vite/client.d.ts 是 renderer 端的，electron-vite/node 没声明）
- db.ts 删除 95 行内联 SQL 字符串，改为 `import { MIGRATIONS } from './migrations'`，loader 逻辑不变（保持 `db.transaction(() => { db.exec + pragma user_version })` 原行为）

### Phase 4 N5：FTS5 历史搜索（CHANGELOG_20 / N5）

- 新增 `src/main/store/migrations/v005_fts.sql`：
  - `events_fts` / `summaries_fts` 虚表（external content 模式 + content_rowid 关联回原表 id，空间最省）
  - tokenizer `'trigram case_sensitive 1'`（substring 友好支持 CJK + 维持原 LIKE BINARY 大小写敏感行为）
  - rebuild 命令全量回填历史索引
  - INSERT / DELETE 触发器（events_ai/ad、summaries_ai/ad）同步 FTS
  - UPDATE 触发器（events_au / summaries_au）带 `WHEN old.X IS NOT new.X` 防御 rename 时白干 N 次 FTS 操作
- 新增 `src/main/store/search-predicate.ts`（80 行）：纯函数 `escapeFtsPhrase` + `buildKeywordPredicate`，按关键词长度切两路（< 3 走 title LIKE-only / ≥ 3 走 title LIKE OR FTS MATCH）
- `src/main/store/session-repo.ts:listHistory` 17 行 LIKE 子查询 → 7 行调 `buildKeywordPredicate`
- 新增 `src/main/store/search-predicate.test.ts`（13 项单测）覆盖：长度门槛 / SQL fragment 内容 / FTS phrase escape（含双引号 / FTS5 保留字 / 中文）

### Phase 4 双对抗修复（REVIEW_3 八处）

按 `~/.claude/CLAUDE.md`「决策对抗」节落地后跑 Opus 4.7 xhigh subagent 挑刺型 review。Opus 现场用 sqlite3 CLI 跑 EXPLAIN QUERY PLAN + 真 SQL 验证（codex CLI 同时跑但 16+ 分钟仍在 prefetch 文件没出结论 → 按 CLAUDE.md「真卡了 TaskStop 中止」处理，Opus 一份独立 reviewer 已给出致命发现足够先动手）：

- **CRITICAL #1**：`search-predicate.ts` `fts MATCH @kw_fts` 别名形态 SQLite parse fail（`no such column: fts`），整条 FTS 路径一搜就抛 → 改 `events_fts MATCH @kw_fts` / `summaries_fts MATCH @kw_fts`（虚表名替代 alias）
- **HIGH #2**：EXISTS+JOIN+LIMIT 1 形态让 query planner 退化成「外层 sessions SCAN + 每行重跑一次 FTS」（CORRELATED SCALAR SUBQUERY），实测 selective 关键词慢 200× → 改 `sessions.id IN (SELECT DISTINCT e.session_id FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE events_fts MATCH @kw_fts)`，让 planner 物化 FTS 命中的小集合 + SEARCH sessions PK
- **HIGH #3**：`events_au` / `summaries_au` 触发器无条件 fire，`sessionRepo.rename()` 改千条 events.session_id 时白干 2N 次 FTS 操作 → 加 `WHEN old.X IS NOT new.X` 子句
- **MED #5**：trigram 默认 case_sensitive=0 → tokenize 加 `case_sensitive 1` 维持原 LIKE BINARY 行为，避免「搜 Foo 突然命中 foo / FOO」的悄悄反转
- **LOW #10**：v005 触发器写虚表依赖 `trusted_schema=ON` → db.ts:initDb 显式 `db.pragma('trusted_schema = ON')` 防御未来 binding 默认变化
- **LOW #11**：`MIGRATIONS.filter` 保留数组顺序 → 加 `.sort((a, b) => a.version - b.version)` 兜底数组乱序
- 部分（暂不修，标注跟踪）：**MED #4** rebuild 在 tx 内同步阻塞 initDb（当前用户库小不阻塞，标注未来若 10w+ events 卡再优化拆 v005a/v005b 分阶段）；**MED #6** vitest 没 vite plugin（本轮集成测试都走 `scripts/verify-fts5.sh` 不依赖 vitest，未踩）；**LOW #7** EXISTS LIMIT 1 死代码（修 #2 时已顺手删）；**LOW #8** prepare 不缓存（debounce 已 bounded）

### 配套：FTS5 真 SQL 集成校验脚本

- 新增 `scripts/verify-fts5.sh`（12 项真 SQL 检查）+ `package.json` 加 `pnpm test:fts5`：用 system sqlite3 CLI 在 :memory: 跑全套 V1-V5 + 12 项检查（schema 应用 / title 命中 / FTS MATCH 表名形态 OK / case_sensitive=1 / 触发器三种 / CASCADE DELETE→FTS 清理 / **alias MATCH 仍被 sqlite3 拒绝的 regression guard**）。不依赖 better-sqlite3 binding（electron 重编版本与本机 node 不兼容）、不依赖 vitest
- **教训沉淀**：单测只 regex 匹配 SQL 字符串会让 broken SQL 蒙混过关，涉及 SQL fragment 构造的纯函数测试要配真 SQL 集成测试。已记入 `.claude/conventions-tally.md` Agent 踩坑候选

## 验证

```
$ pnpm typecheck   ✅
$ pnpm test        ✅ 27 passed (vitest)
$ pnpm test:fts5   ✅ 12 passed (sqlite3 CLI)
$ pnpm build       ✅ main bundle 含 events_fts 等 SQL 字面量（?raw inline 真生效）
```

后续手测（用户重启 dev / 安装 dmg 时验证）：

- **N4 单轨化**：DB 已存在 user_version=4 的库启动应只跑 v005（migration 增量；老库不重跑）；空白库启动应顺序跑 V1-V5 全部 5 个
- **N5 FTS5 真行为**：在 HistoryPanel 搜 ≥ 3 字符关键词（英文 / 中文 / 含 `.ts` `_id` 的 substring），命中应远快于改前 LIKE 全表扫；搜 1-2 字符仍只搜 title；大小写敏感行为应与改前一致
- **N4 #4 首启回填**：当前用户库的 events 表行数 + initDb 时长（如果几万行就启动卡几秒 → reviews 跟踪条目升级时机）

## 关联文件清单

- 新增（4 个 sql + 1 ts + 1 dts + 1 sh + 1 test）：`src/main/store/migrations/{v002_sessions_source,v003_split_archive_from_lifecycle,v004_sessions_permission_mode,v005_fts}.sql` / `src/main/store/migrations/index.ts` / `src/main/store/search-predicate.ts` / `src/main/store/search-predicate.test.ts` / `src/main/vite-env.d.ts` / `scripts/verify-fts5.sh`
- 改动主线：`src/main/store/db.ts`（删 95 行内联 SQL + 加 trusted_schema PRAGMA + sort 防御）/ `src/main/store/session-repo.ts:listHistory`（改调 buildKeywordPredicate）/ `package.json`（加 `test:fts5` script）
- 关联 review：[REVIEW_3.md](../reviews/REVIEW_3.md)

## 备注

- 不进 plan 的 [N9] adapter capabilities 链式访问漏 ?. / [N10] claude-config dev/prod 路径分歧 / [N11] closed 复活双广播 / [N12] route-registry 缺 unregister 仍在 plan tally section 跟踪
- Phase 4 N5 FTS5 真行为依赖 better-sqlite3 编译时打开 FTS5（11.10.0 默认开），未来升 SDK 时若 disable FTS5 会启动 fail（`unknown module: fts5`），届时降级回 LIKE 形态可走「检测 sqlite_compileoption_used('ENABLE_FTS5')` 兜底」
- Phase 4 完成 = 整套架构评审落地完毕（Phase 0 H 级 + Phase 1 SettingsDialog + Phase 2 测试基建 + ingest 拆 + Phase 3 SettingsSet/notify/summarizer + Phase 4 N4/N5）
- 决策对抗教训记入 `.claude/conventions-tally.md`：Phase 4 实施后才跑对抗本应放 plan 阶段更前置，但实际证明「实施后跑对抗」也抓出真致命 broken SQL（Opus 现场跑 EXPLAIN/SQL 是单 prompt 无法做到的），属可接受路径
