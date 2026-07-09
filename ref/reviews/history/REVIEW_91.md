# REVIEW_91 — 全项目 deep review 批 G4：杂项 store（event/file-change/summary/image-uploads/payload-truncate/search-predicate/message-delivery-state/db/migrations）

- 日期: 2026-06-01
- 类型: Debug / 功能 BUG（同毫秒排序确定性 + 搜索语义 + 路径守卫 + 资源预分配）+ 文档漂移修复（全项目 deep review 第二十一批，Batch G 子批 G4）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_90（G3 message-repo same-ms rowid 先例）/ REVIEW_89（G2 team-repo list rowid DESC 先例）/ REVIEW_88（G1 cwd LIKE escape 先例）/ REVIEW_84（E2 event-formatter same-ms tie-breaker 先例）/ REVIEW_52/54（event-repo listForSession F3 tie-breaker + UPSERT partial index）/ REVIEW_2（file-change-repo tie-breaker）/ REVIEW_61（task subject LIKE escape）/ CHANGELOG_22（FTS5 + trigram）/ CHANGELOG_109（message-delivery-state SSOT）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，fresh pair dr-project-g4-20260531，换 caller hand-off 重 spawn）+ 三态裁决 + lead 现场 `sqlite3 :memory:` / `node` 探针实证 + **SQLite binding rebuild 真测**（7 tie-breaker test + temp-revert 全 FAIL 验证）+ Electron binding 还原。
- 收口: R1→R2 两轮。**异构高度收敛**（tie-breaker / LIKE escape / deleteUploadIfExists 三条全双方独立命中，零 HIGH 零 reviewer 分歧无需反驳轮）；codex 互补补出 FTS case-sensitivity / base64 decode-before-check / payload-truncate cycle 三条。R2 双方独立确认「可合」+ 0 HIGH/MED 残留。

## 范围（批 G4）

`src/main/store/` 杂项 store 9 文件 ~1225 LOC（better-sqlite3 同步 repo 层 + 纯 helper）+ 辅助 migration（FK / PRAGMA / partial UNIQUE / FTS 触发器 字节一致性）：

| 文件 | LOC | 职责 |
|---|---|---|
| event-repo.ts | 253 | events 表 CRUD + UPSERT dedup + team 聚合 + summarizer 兜底查询 |
| image-uploads.ts | 236 | 用户上传图片写盘 / 加载 / reaper（路径白名单 + TOCTOU 守卫） |
| message-delivery-state.ts | 216 | agent_deck_messages 投递状态机 SSOT（BACKOFF_TIERS / coerceMessageStatus / buildFindEligibleWhereSql） |
| payload-truncate.ts | 144 | payload UTF-8 字节安全截断（单字段 64KB / 整体 256KB marker 降级） |
| file-change-repo.ts | 85 | file_changes 表 CRUD |
| search-predicate.ts | 83 | 历史搜索关键词谓词构造（title LIKE + FTS5 MATCH） |
| migrations/index.ts | 74 | migration 注册表（v001-v026） |
| summary-repo.ts | 72 | summaries 表 CRUD + 批量最新 summary 窗口查询 |
| db.ts | 62 | better-sqlite3 init / PRAGMA / migration runner |
| 辅助: v001/v005/v022/v025 | — | events/file_changes/summaries 表 + FK CASCADE / FTS 虚表+触发器 / events 双 partial UNIQUE |

## 收敛与裁决

R1 双方各出一轮 finding（claude 4 MED + 1 LOW + 3 INFO / codex 4 MED + 2 LOW + 1 INFO），**复发主题「同毫秒 ORDER BY tie-breaker」第 4 次命中**（前 G2/G3/E2），本批清空 event-repo + summary-repo 全部剩余 list 查询。

### ✅ 双方独立提出（must-fix）

**MED-1 summary-repo same-ms tie-breaker（summary-repo.ts:38/49/67）** — claude MED / codex MED
三处 list/latest 查询全缺 `id` 二级键：`listForSession` / `latestForSession` `ORDER BY ts DESC`，`latestForSessions` 窗口 `ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC)`。同一 session 同毫秒插两条 summary 时返回较旧行，破坏「最新一条」语义。`latestForSessions` 被 ipc/sessions.ts:41 真实消费（SessionList 显示旧 summary）。
- 验证: sqlite3 实测同 ts=1000 两行 `ORDER BY ts DESC LIMIT 1` 返 id=1（旧），加 `id DESC` 返 id=2（新）。
- 修法: 三处统一 `ORDER BY ts DESC, id DESC`（窗口同款）。与 event-repo F3 / file-change-repo REVIEW_2 同款。

**MED-2 event-repo 剩余 same-ms tie-breaker（event-repo.ts:154/190/196/255）** — claude MED / codex MED
`listForSession`（REVIEW_52 F3）已修，但 `findTeamEvents`（:154，跨多 session IN 查询同 ts 碰撞概率更高 → TeamDetail 事件流刷新跳序）/ `findLatestAssistantMessage`（:190,196 两分支，summarizer 第二层兜底取错 assistant message）/ `listForSessionRange`（:255，**ASC 查询配 `id ASC`** 方向匹配 ts ASC）仍缺。
- 验证: grep 确认 4 处无二级键 + sqlite3 复现同毫秒乱序。
- 修法: DESC 加 `id DESC`，ASC 加 `id ASC`。

**MED-3 search-predicate title LIKE 未 escape `% _ \`（search-predicate.ts:55-82）** — claude MED / codex LOW
`kw_like: %${keyword}%` 直接拼，未 escape 也无 `ESCAPE '\'`。但**同一 listHistory query** 的 cwd（core-crud.ts:162，REVIEW_88）和 task subject（task-repo-list.ts:49，REVIEW_61）都已修 —— title 是 REVIEW_88 修 cwd 时漏掉的兄弟。用户搜含 `_` 的标题（如 `my_project`）→ `_` 被当单字符通配匹配 `myXproject`。非注入（命名参数挡），是搜索语义错误。
- 验证: lead grep 三方对比（cwd/subject 有 escape，title 无）+ sqlite3 `LIKE '%a_c%'` 命中 abc/a_c，`ESCAPE '\'` 只命中 a_c。
- 修法: buildKeywordPredicate 内 escape `\`→`\\`/`%`→`\%`/`_`→`\_`（escape 顺序 `\` 优先避二次转义）+ 两处 `title LIKE @kw_like ESCAPE '\'`；FTS phrase 侧 escapeFtsPhrase 不动。同步更新 test L81-97（原断言「不另加 escape」改为断言正确转义 + 加 `_` / `\` 正向 case）。

**MED-4 deleteUploadIfExists `..` 穿越守卫缺陷（image-uploads.ts:203）** — claude MED / codex LOW（双方均诚实标不可达）
安全门只做字符串 `path.startsWith(prefix)`，无 normalize/realpath。`<uploadsDir>/../agent-deck.db` 通过 prefix 检查，unlink 解析后删库外文件。注释自称「杜绝传任意路径删盘」契约为假。
- 可达性（诚实标注）: 当前 3 caller（adapters.ts:94/180/284、codex sdk-bridge:438）全传 writeUploadedImage 生成的 server 端 UUID 路径（renderer 只能传 base64 不能传 path）→ **无可达攻击面**，潜在风险 + 误导注释，非当前漏洞。
- 验证: node 实测 `dir + '/../agent-deck.db'` 时 `startsWith(prefix)===true`。
- 修法: `resolve(path)` 词法折叠 `..` 后再判 startsWith（不走 realpath：unlink 目标可能已不存在 realpath 会 ENOENT；uploads 扁平目录无内部 symlink，resolve 纯词法归一已足够 + `fs.unlink` 不跟随终端 symlink）。R2 双方独立实测确认 resolve() 是此场景正解。

### ✅ 单方提出 + lead 现场验证（must-fix，severity 经裁决）

**LOW base64 decode-before-size-check（image-uploads.ts:75）** — codex MED → lead 裁 LOW
`writeUploadedImage` 先 `Buffer.from(input.base64,'base64')` 分配完整 Buffer，再校验 `buf.length !== bytes` / `> MAX_IMAGE_BYTES`。IPC 预检（adapters.ts:65-84）只累加 renderer 上报的 bytes，base64 本身不受约束 → 恶意大字符串先吃主进程内存再被拒。
- 验证: lead 读 adapters.ts:65-84 确认预检只累加上报 bytes（reachable）+ codex node 实测 `'A'.repeat(4M)` 生成 3M Buffer 与上报无关。
- 裁 LOW 理由: 当前 caller 是 first-party renderer + 瞬时分配（非持久泄漏）。
- 修法: decode 前按 base64 字符串长度做硬上限 `ceil(MAX_IMAGE_BYTES*4/3)+4`（4/3 膨胀比 + padding），精确字节对账仍由下方 buf.length 完成。R2 双方实测公式边界：cap=27962031 ≥ 满额图 canonical 长 27962028（不误拒），超标串 decode 最多 MAX+3 被 buf.length 兜住。

**INFO payload-truncate 注释漂移 + cycle 澄清（payload-truncate.ts:6/106）** — codex INFO
文件头 + safeStringifyPayload 注释说单字段截「8KB」，常量已是 `64*1024`。且注释说「深度限制避免 cycle」，实际 `depth>3` 返原对象 → 输出仍含 cycle，下游 `JSON.stringify` 抛 TypeError。
- 验证: lead node 实测 `o.self=o` 与 depth4 cycle 经 shrink 后 JSON.stringify 均抛 `Converting circular structure to JSON`。
- 修法: 注释 8KB→64KB + 如实说明 depth>3 不消除 cycle（当前 event payload 全 JSON-origin SDK 数据天然无 cycle 故未加 WeakSet guard，文档化而非加防御）。

**INFO event-repo limit 注释漂移（event-repo.ts:165）** — lead pre-verify
jsdoc 说「listForSession 默认 limit=40」，实际默认 200（:104），40 是 summarizer caller 传值（summarizer/index.ts:253）。
- 修法: 注释澄清「summarizer caller 传 40，listForSession 默认 200」。

### ✅ 注释更正（验证为真 bug，但修复属行为变更超出授权 → 注释如实 + Follow-up）

**FTS case_sensitive 注释与实际相反（v005_fts.sql:12-21）** — codex MED，lead sqlite3 实证
注释称 `case_sensitive 1` 「维持历史 LIKE 大小写敏感行为」，但 SQLite `LIKE` 对 ASCII **默认大小写不敏感**。`case_sensitive 1` 反而让 events_fts/summaries_fts MATCH 大小写敏感，与同一 listHistory query 的 `title LIKE`（大小写不敏感）**分裂**：搜 "Foo" 命中含 "foo" 的标题但漏掉含 "foo" 的事件正文。
- 验证: lead sqlite3 实测 `'foo' LIKE '%Foo%'` → 1 / `case_sensitive 1 MATCH '"Foo"'` on "foobar" → 0 / `case_sensitive 0` → 1（codex 独立同款 + R2 复核）。
- 处置: 注释从「维持 LIKE 行为」更正为如实说明它与 LIKE **相反**导致分裂。**改 `case_sensitive 0` 对齐 LIKE 属搜索行为变更（需 FTS rebuild + changelog 公告），超出本 review「不改协议级 breaking change」授权 → 留 Follow-up #13 给用户决策**。R2 双方确认无绕开 rebuild 的轻量对齐方案（COLLATE BINARY 是反向把 title 改敏感 = UX 倒退）。

### Clean 维度（双方独立确认）

- **file-change-repo**: listForSession 已 `ts DESC, id DESC`（REVIEW_2）；rowToRecord metadata parse 有 try/catch 兜底。
- **event-repo insert UPSERT**: partial conflict target `WHERE kind=... AND tool_use_id IS NOT NULL` 与 v022/v025 partial index WHERE 字节对齐；RETURNING id 取 victim 正确（DO UPDATE 时 lastInsertRowid 会错）；extractToolUseId 空串→null 与 partial index 一致。
- **message-delivery-state**: MAX_RETRY===BACKOFF_TIERS.length+1 module-load invariant 自检 + 升序连续 + 非负校验齐全；buildFindEligibleWhereSql OR 链被 caller 正确包进 `WHERE status='pending' AND (...)`（dispatch.ts），无 precedence bug，已带 rowid ASC（REVIEW_90）。
- **payload-truncate truncateStringByBytes**: UTF-8 continuation-byte 回退算法正确（`🦄x` maxBytes=2 → '' 文档案例成立）；byteLength 全程用对；marker 降级路径 OK。
- **db.ts / FK / PRAGMA**: WAL + foreign_keys=ON + trusted_schema=ON；migration 单事务 + version 排序兜底；v001 三表全 ON DELETE CASCADE。v017/v023 表重建安全（被重建表无外部 FK 反引用，v017 注释自证）。
- **fd / 资源 lifecycle**: loadUploadedImage finally close fd；reaper 目录不存在 + 单文件失败双兜底。

## 修复清单

| # | 文件:行 | 修法 | 裁决 |
|---|---|---|---|
| 1 | summary-repo.ts:38/49/67 | 三处 `ORDER BY ts DESC` → `ts DESC, id DESC`（含窗口 PARTITION） | ✅ 双方独立 MED |
| 2 | event-repo.ts:154/190/196 | DESC 加 `id DESC`；:255 listForSessionRange ASC 加 `id ASC` | ✅ 双方独立 MED |
| 3 | search-predicate.ts:61-82 + test | keyword escape `\ % _` + 两处 title LIKE 加 `ESCAPE '\'` + 更新/新增 3 test | ✅ 双方独立（claude MED/codex LOW） |
| 4 | image-uploads.ts:203 + :23 | deleteUploadIfExists `resolve(path)` 折叠 `..` 后判 startsWith + import resolve | ✅ 双方独立防御 |
| 5 | image-uploads.ts:75 | writeUploadedImage decode 前加 base64 length cap `ceil(MAX*4/3)+4` | codex MED → 裁 LOW |
| 6 | payload-truncate.ts:6/106 | 注释 8KB→64KB + 澄清 depth>3 不消除 cycle | codex INFO |
| 7 | event-repo.ts:165 | 注释 limit=40 → 澄清 summarizer caller 传 40 / 默认 200 | lead INFO |
| 8 | v005_fts.sql:12-21 | case_sensitive 注释更正（与 LIKE 相反 → 分裂）+ 指向 Follow-up #13 | codex MED（注释，行为变更留 Follow-up） |

## 测试

- **新增** `src/main/store/__tests__/repo-tiebreaker.test.ts`（7 test：event-repo `findTeamEvents`/`findLatestAssistantMessage`×2/`listForSessionRange` 4 + summary-repo `listForSession`/`latestForSession`/`latestForSessions` 3）。harness 照搬 v025-migration.test.ts（vi.mock `@main/store/db` + dbHolder 注入 in-memory testDb + 动态 import 生产 repo 跑真 SQL）。
- **SQLite binding rebuild 真测**（plan §当前进度 binding 流程）：nvm use 20.18.3 + prebuild-install --target 20.18.3 → 7 test passed → **temp-revert（去掉所有 `, id DESC`/`, id ASC`）全 7 FAIL 验证有效**（含 `expected 'NEW' to be 'OLD'` 等）→ 还原 Electron binding（size 1885024）。
- search-predicate.test.ts 加 3 escape case（`100%`→`%100\%%` / `my_project`→`%my\_project%` / `a\b`→`%a\\b%`），原「不另加 escape」断言改为正确转义。共 15 test passed（pure-fn，node 直跑）。
- **typecheck 双配置全绿**（tsconfig.node + tsconfig.web）。payload-truncate.test.ts 12 test passed。
- **pre-existing 失败声明**（与 G4 无关，git stash 验证 HEAD 无本改时同样 7 fail）：task-repo.test.ts 2（损坏 JSON 容错）/ v023-migration.test.ts 1（幂等性）/ cwd-release-marker.test.ts 4（`no such column: owner_session_id`）—— 均 SQLite 真测 binding rebuild 环境下 test 侧 setup 工件，留各自 store 子批 / Follow-up #9 线索专项排查。

## Follow-up（新增）

13. **[MED 已验证 行为变更] FTS case_sensitivity 与 title LIKE 分裂**（REVIEW_91，reviewer-codex G4）— `v005_fts.sql` `case_sensitive 1` 让 events_fts/summaries_fts MATCH 大小写敏感，与 title LIKE（默认大小写不敏感）分裂：搜 "Foo" 命中含 "foo" 标题但漏含 "foo" 事件正文。本 review 仅更正注释如实说明（未改行为）。对齐方案唯有 FTS `case_sensitive 0` + rebuild + changelog 公告（搜索语义变更）。lead sqlite3 + 双 reviewer R2 实证确认无绕开 rebuild 的轻量方案。留用户决策方向（大小写敏感 vs 不敏感作为历史搜索默认）。

14. **[INFO 公式前提备忘] base64 length cap 假设无换行 base64**（REVIEW_91，reviewer-claude G4 R2）— `image-uploads.ts:75` 前置 cap `ceil(MAX*4/3)+4` 隐含假设 renderer 传无换行 base64。若未来 renderer 改 MIME-formatted（76 列 `\n`）base64，满额图长度 28329949 > cap 会误拒。当前 browser `btoa` / `FileReader.readAsDataURL` 均不产换行 → 不可达，仅作公式前提备忘。
