/**
 * session-repo —— rename（最复杂的跨表迁移操作）。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 */

import type { Database } from 'better-sqlite3';
import { getDb } from '../db';
import type { Row } from './types';

/**
 * 把 sessions 表里 fromId 改名 toId，并把 events / file_changes / summaries / team_members
 * / messages.from_session_id / messages.to_session_id / sessions.spawned_by 自引用 / tasks
 * / issues / issue_appendices 的 session FK 一起迁移。整体在事务内做，避免外键 CASCADE / SET NULL
 * 误删 / 误断历史。用于 SDK fallback：tempKey 占位行 → 真实 session_id 出现后无损迁移。
 *
 * REVIEW_17 R2 / H1-R2：toExists=true 分支（recoverAndSend jsonl-missing 走
 * 不带 resume 的 createSession + 事后 rename 时触发——NEW_ID 已被 createSession
 * 写过一行）原本仅迁子表 + DELETE OLD，permission_mode 等用户预期
 * 跟随 OLD 一起搬过来的字段被丢弃。比如：用户在 OLD 里选了 acceptEdits 模式，
 * recoverAndSend 路径 createSession 默认 'default' → 修复后用户 permissionMode 丢档。
 *
 * 修法：toExists=true 时把 fromRow 的 permission_mode / spawn_link 同步覆盖到
 * 新行（这两类是「会话身份持续性」相关）。其他列（cwd / title / activity / lifecycle
 * 等）由 createSession 已写就绪，不应被 OLD 行旧值覆盖。
 *
 * plan linked-swimming-platypus（v017）：原过期 contract「session_id 改名时需调
 * sessionManager.delete 路径的 leaveTeam 兜底（已实现），或 rename 后由 caller 自行
 * leaveTeam(OLD) + addMember(NEW)」**所有 6 处 renameSdkSession caller 均无实现**，
 * 加之 leaveTeam 只 UPDATE left_at 不删 row → DELETE OLD 必撞 FK ON DELETE RESTRICT
 * （用户报 bug：fork rename 后 SDK 流中断 "FOREIGN KEY constraint failed"）。
 *
 * 修法（双轨）：
 * 1. v017 schema：agent_deck_team_members.session_id 改 ON DELETE CASCADE，让
 *    sessions DELETE 不再撞 FK（同时根治 sessionManager.delete 隐藏 bug）
 * 2. rename 内显式 UPDATE 迁 team_members.session_id 让 NEW 续接 OLD 在 team 的
 *    lead/teammate 角色（不依赖 CASCADE 自动删 —— 那会让 NEW 失去 membership →
 *    team 自动 archive，违反 rename「OLD 整个迁到 NEW 名下」语义）
 * 3. 同步 UPDATE agent_deck_messages.from/to_session_id（FK 不强制但 watcher 反查
 *    sessionRepo.get(toSessionId) 会因 OLD 不存在 markFailed 假阴性）
 * 4. 同步 UPDATE sessions.spawned_by 自引用（v009 ON DELETE SET NULL 兜底不撞 FK，
 *    主动 UPDATE 是为保 spawn chain 完整性更友好）
 */
export function rename(fromId: string, toId: string): void {
  renameWithDb(getDb(), fromId, toId);
}

/**
 * Test seam（plan linked-swimming-platypus）：让 agent-deck-repos.test.ts 用 in-memory db
 * 真测 rename 迁移行为（v017 + 三段 UPDATE 不撞 FK + NEW 续接 OLD 角色）。生产路径走
 * `rename(fromId, toId)` 默认 wrapper 用 getDb()；测试路径走本函数显式传 db。
 */
export function renameWithDb(db: Database, fromId: string, toId: string): void {
  if (fromId === toId) return;
  const tx = db.transaction(() => {
    const fromRow = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(fromId) as Row | undefined;
    if (!fromRow) return; // tempKey 行不存在就什么都不做
    const toExists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(toId) as
      | { 1: number }
      | undefined;
    if (!toExists) {
      // 复制 fromRow 内容到新 id（id 是 PK，必须 INSERT 新行）
      // CHANGELOG_<X> R2 / B'0 ADR §6.5.2 #2-#3：列清单扩到 16 列（顺手补 v008
      // codex_sandbox 漏列 latent bug，再加 R2 v009 spawned_by/spawn_depth）。
      // R4·F2：列再扩 1 → 17 列（generic_pty_config）。
      // CHANGELOG_74：列再扩 1 → 18 列（claude_code_sandbox）。
      // plan team-cohesion-fix-20260513 Phase A Step A9：v014 drop sessions.team_name 后
      // 列回缩 1 → 17 列。
      // plan cross-adapter-parity-20260515 Phase A Step A.2：列扩 2 → 19 列(顺手补
      // v018 model 漏列 latent bug + 加本 plan 的 v019 extra_allow_write)。
      // model latent bug 触发场景:recoverAndSend jsonl-missing fallback path → toExists=false
      // INSERT path 时 model 字段未带过来 → resume 拿不到 spawn 时 frontmatter 设的 model。
      // 实测虽未 user-report 但与 permission_mode 同款风险已被 REVIEW_17 R2 / H1-R2 治过,
      // 本 plan 列扩同 modules 顺手补齐(commit message 透明注明)。
      // plan codex-handoff-team-alignment-20260518 P1 Step 1.1 H1 关键修法:列扩 1 → 20 列
      // (v020 cwd_release_marker)。SDK fork / recover rename 路径必须把此列从 fromRow 复制
      // 到 NEW 行,否则 codex teammate mcp enter_worktree 设的 marker 在 fork 后丢失,
      // 下次 archive_plan 预检走「在 worktree 内 + 无 marker」分支 reject(状态 3)
      // — 完全堵死跨 adapter / 外部 caller 路径的解锁意义。
      // plan reverse-rename-sid-stability-20260520 §A.2 关键修法:列扩 1 → 21 列 (v021 cli_session_id)。
      // **R6 HIGH-R6-1 + R7 HIGH-R7-1 修订**: spawn 主路径 (toExists=false INSERT) cli_session_id
      // hardcode `toId` (= first realId, S2 jsdoc spawn 路径 applicationSid 切到 realId 后冻结),
      // 不复制 fromRow.cli_session_id (避免 tempKey 阶段 NULL / fromRow stale value 带过来)。
      // toExists=true 分支 cli_session_id 处理: see L213+ — **R5 MED-R5-1 + R7 HIGH-R7-1 修订**:
      // 保留 NEW 行已有 cli_session_id 不覆盖 (语义 != cwd_release_marker 无条件覆盖,详注释)。
      db.prepare(
        `INSERT INTO sessions
         (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, codex_sandbox, claude_code_sandbox, model, extra_allow_write, cwd_release_marker, spawned_by, spawn_depth, generic_pty_config, cli_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        toId,
        fromRow.agent_id,
        fromRow.cwd,
        fromRow.title,
        fromRow.source,
        fromRow.lifecycle,
        fromRow.activity,
        fromRow.started_at,
        fromRow.last_event_at,
        fromRow.ended_at,
        fromRow.archived_at,
        fromRow.permission_mode,
        fromRow.codex_sandbox,
        fromRow.claude_code_sandbox,
        fromRow.model,
        fromRow.extra_allow_write,
        fromRow.cwd_release_marker,
        fromRow.spawned_by,
        fromRow.spawn_depth,
        fromRow.generic_pty_config,
        toId,  // ← cli_session_id hardcode toId (R6 HIGH-R6-1 + R7 HIGH-R7-1 修订:spawn 主路径 first realId 即 toId)
      );
    }
    // 迁移子表引用（外键 ON DELETE CASCADE 在删 fromId 时不会误删，因为 session_id 已改）
    db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE file_changes SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE summaries SET session_id = ? WHERE session_id = ?`).run(toId, fromId);

    // plan linked-swimming-platypus (a) team_members 迁移：从 OLD 改名到 NEW，让 NEW
    // 续接 OLD 在 team 的 lead/teammate 角色。v017 schema CASCADE 兜底不撞 FK，但 OLD
    // 一旦被 DELETE 其 team_members 会被级联清 → NEW 失去 membership → team 自动 archive
    // → 违反 rename「OLD 整个迁到 NEW 名下」语义。所以**必须**显式 UPDATE 在 DELETE OLD 之前。
    //
    // PK = (team_id, session_id)。fork 路径下 NEW 不会被 spawn handler 提前 addMember
    // （createSession 不调 addMember，addMember 仅在 spawn handler 路径），所以 PK
    // 冲突 100% 不发生；防御性先删 NEW 在同 team 已有 row（保 OLD 优先），为未来
    // spawn handler 改动留 latitude，不增加 IO 开销（无 row 时 DELETE 0 changes）。
    db.prepare(
      `DELETE FROM agent_deck_team_members
       WHERE session_id = ?
         AND team_id IN (SELECT team_id FROM agent_deck_team_members WHERE session_id = ?)`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE agent_deck_team_members SET session_id = ? WHERE session_id = ?`,
    ).run(toId, fromId);

    // plan linked-swimming-platypus (b) messages.from/to_session_id 迁移：FK 不强制
    // （v010 设计允许已删 sender 留痕），但 universal-message-watcher 反查
    // sessionRepo.get(toSessionId) 拿 receiver session 做投递；rename 后 OLD 不在
    // sessions 表 → markFailed("target session not found") → wait_reply 等的 lead
    // 收到假阴性。UPDATE 双字段保引用一致性（与 universal team backend 设计一致：
    // rename 后 NEW 接管 OLD 在 messages 流里的 sender / receiver 角色）。
    db.prepare(
      `UPDATE agent_deck_messages SET from_session_id = ? WHERE from_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE agent_deck_messages SET to_session_id = ? WHERE to_session_id = ?`,
    ).run(toId, fromId);

    // plan linked-swimming-platypus (c) sessions.spawned_by 自引用迁移：v009 ON DELETE
    // SET NULL 兜底，DELETE OLD 自动断链不会撞 FK。但 spawn chain 完整性更友好：UPDATE
    // 让 OLD 派生的子 session 仍指向 NEW（spawned_by 用于 §6.4 per-parent fan-out 反查
    // + listAncestors / listChildren，应用层不强依赖非 null 但保留更直观）。
    db.prepare(
      `UPDATE sessions SET spawned_by = ? WHERE spawned_by = ?`,
    ).run(toId, fromId);

    // **REVIEW_83 MED (reviewer-codex 单方 R2 + lead 现场验证 — 现 latent / 未来防 footgun)**:
    // tasks / issues / issue_appendices 的 session FK 迁移。rename 语义是「OLD 整迁到 NEW
    // 名下」,但本 helper 的子表迁移清单写于 v021(reverse-rename plan,commit 579f934)之前,
    // **晚于** v023(tasks.owner_session_id NOT NULL ON DELETE CASCADE) / v026(issues
    // source/resolution_session_id + issue_appendices.appended_session_id ON DELETE SET NULL)
    // 加 FK — 清单从未补这三表。若不迁,下方 DELETE OLD 会:① CASCADE 物理删 OLD 拥有的 task
    // ② SET NULL 断 OLD 上报 / 解决的 issue 归属 + appendix 快照 → 违反 rename 不变量 + 断
    // hand-off / task / issue 权限链。
    //
    // **当前可达性裁决 (lead 现场验证,故定 MED 非 codex 所提 HIGH)**:现两个 live caller
    // 都是 renameSdkSession(tempKey, realId) spawn bootstrap —— (a) codex thread-loop.ts:171
    // tempKey 行从未进 sessions 表(等 thread.started 才 claim,session-start emit 用 realId)→
    // FK 要求 owner 行存在故无 task 挂 tempKey → rename noop;(b) claude stream-processor.ts:338
    // applicationSid 在同一首条 SDK 消息 handler 先切 realId(L331)再 rename(L338),早于 agent
    // 任何 tool_use → task_create callerSid 解析为 realId 不挂 tempKey。recoverer jsonl-missing
    // 早已改 resumeMode='fresh-cli-reuse-app' 复用 applicationSid + updateCliSessionId(不删行
    // 不 rename)→ toExists=true 分支对 recoverer 已 dead。故现无 live 数据丢失,但 **一次重构
    // 之差**(任何新 caller rename 一个已积累 task/issue 的长存 session)即 silent 数据损坏 →
    // 按「会话身份迁移」不变量补齐,与上面 6 表同段迁移对称。
    //
    // 迁移用 UPDATE(不撞 PK:tasks PK=id UUID / issues PK=id / appendix PK=id,session 列均非
    // PK,NEW 已有自己的 task/issue 也只是并存不冲突)。在 DELETE OLD 之前跑,避开 CASCADE/SET NULL。
    db.prepare(
      `UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE issues SET source_session_id = ? WHERE source_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE issues SET resolution_session_id = ? WHERE resolution_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE issue_appendices SET appended_session_id = ? WHERE appended_session_id = ?`,
    ).run(toId, fromId);

    // REVIEW_17 R2 / H1-R2：toExists=true 时（recoverAndSend jsonl-missing fallback）
    // 把会话身份相关字段从 OLD 行覆盖到 NEW 行，避免 permission_mode 被 NEW 行
    // createSession 时写的默认值（'default'）「淹没」掉用户的真实状态。
    // 仅在 toExists=true 才需要手动覆盖：toExists=false 走上面 INSERT 已经全列复制。
    if (toExists && fromRow.permission_mode) {
      db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(
        fromRow.permission_mode,
        toId,
      );
    }
    if (toExists && fromRow.codex_sandbox) {
      db.prepare(`UPDATE sessions SET codex_sandbox = ? WHERE id = ?`).run(
        fromRow.codex_sandbox,
        toId,
      );
    }
    if (toExists && fromRow.claude_code_sandbox) {
      // CHANGELOG_74：与 codex_sandbox 同款 — recoverAndSend / SDK fallback rename 时
      // 必须从 fromRow 覆盖到 NEW 行，否则用户在 NewSessionDialog / ComposerSdk 选过的
      // OS 沙盒档位被 NEW 行 createSession 时写的全局默认值「淹没」掉。
      db.prepare(`UPDATE sessions SET claude_code_sandbox = ? WHERE id = ?`).run(
        fromRow.claude_code_sandbox,
        toId,
      );
    }
    if (toExists && fromRow.spawned_by) {
      db.prepare(`UPDATE sessions SET spawned_by = ? WHERE id = ?`).run(fromRow.spawned_by, toId);
    }
    if (toExists) {
      // REVIEW_56 Batch C R1 claude M-2 修法:spawn_depth 是 INTEGER NOT NULL,0 是合法值
      // (root session;与 spawn_link.parent_depth=-1 协同标记无 parent)。旧实现 truthy check
      // `> 0` 把 OLD 是 root session 的事实丢失,与同段其他 string|null 字段语义不一致 — 那些
      // truthy 跳过对(null 跳过保留 NEW user preference 默认值);spawn_depth 是 INTEGER NOT
      // NULL 会话身份相关字段,应与 cwd_release_marker L220 / toExists=false INSERT 分支同款
      // 无条件 OLD 覆盖。当前 NEW createSession 默认 spawn_depth=0 巧合下无 user-visible
      // 问题,但 latent risk:若未来 createSession 改默认或 schema 调 spawn_depth 默认,会被
      // truthy 跳过吞掉 OLD root session 身份。修法对齐"会话身份相关字段无条件覆盖"语义。
      db.prepare(`UPDATE sessions SET spawn_depth = ? WHERE id = ?`).run(fromRow.spawn_depth, toId);
    }
    if (toExists && fromRow.generic_pty_config) {
      // R4·F2：老 PTY-based session 的 spawn config 是会话身份相关字段，
      // recoverAndSend / SDK fallback rename 时必须从 fromRow 覆盖到 NEW 行，
      // 否则 lifecycle 复活路径丢失 config，resume 按错 args 重 spawn（与 codex_sandbox 同模式）。
      // (plan remove-aider-generic-pty-adapters-20260520 后 adapter 已删,column 保留兼容老 rows。)
      db.prepare(`UPDATE sessions SET generic_pty_config = ? WHERE id = ?`).run(
        fromRow.generic_pty_config,
        toId,
      );
    }
    if (toExists && fromRow.model) {
      // plan cross-adapter-parity-20260515 Phase A Step A.2 顺手修 v018 model 漏列 latent bug:
      // recoverAndSend / SDK fallback rename(toExists=true 分支)时 model 必须从 fromRow 覆盖到
      // NEW 行,否则 NEW 行 createSession 时写的 default(null)「淹没」掉 spawn 时 frontmatter
      // 设的 model — 与 permission_mode / codex_sandbox / claude_code_sandbox 同模式。
      db.prepare(`UPDATE sessions SET model = ? WHERE id = ?`).run(fromRow.model, toId);
    }
    if (toExists && fromRow.extra_allow_write) {
      // plan cross-adapter-parity-20260515 Phase A Step A.2:extra_allow_write 同 codex_sandbox
      // 同款 — recoverAndSend / SDK fallback rename(toExists=true 分支)时必须从 fromRow 覆盖
      // 到 NEW 行,否则用户 spawn / hand_off_session 时传的 extra_allow_write(让外置 worktree
      // session 能写 mainRepo plan 文件)被 NEW 行 createSession 时写的 NULL「淹没」掉,
      // 后续 recoverer 路径 SDK sandbox.allowWrite 不含原 mainRepo → 写 plan 文件静默失败。
      db.prepare(`UPDATE sessions SET extra_allow_write = ? WHERE id = ?`).run(
        fromRow.extra_allow_write,
        toId,
      );
    }
    if (toExists) {
      // plan codex-handoff-team-alignment-20260518 P1 Step 1.1 H1 关键修法 (toExists 分支):
      // cwd_release_marker 与 permission_mode / codex_sandbox / extra_allow_write / model 行为
      // **不同** — 那些是 user preference (OLD 未设时保留 NEW 已有偏好),marker 是 transient
      // session state (worktree 持有标记) 必须无条件按 OLD 覆盖 (P5 Round 1 reviewer-codex MED-2
      // 修法):OLD null + NEW stale value 时 NEW 应清空 (rename = OLD 接管 NEW 身份,worktree
      // 持有状态必须以 OLD 为准),否则 codex SDK 隐式 fork 后 stale marker 跟到新 sid 触发
      // archive_plan 状态 4 (marker != worktree) 误 reject。
      // 与 toExists=false INSERT 分支同款无条件复制 marker (核心 SQL 已包含此列,binds 直接传)。
      db.prepare(`UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`).run(
        fromRow.cwd_release_marker,
        toId,
      );

      // plan reverse-rename-sid-stability-20260520 §A.2 / R5 MED-R5-1 + R7 HIGH-R7-1 修订:
      // cli_session_id 在 toExists=true 分支语义**不同**于 cwd_release_marker (上方无条件覆盖):
      // - cwd_release_marker 是 transient session state,OLD null + NEW stale 时必须以 OLD 为准
      // - cli_session_id 是反查 key (有副作用,影响 jsonl 路径 / SDK resume / ingest 反查),
      //   toExists=true 分支 NEW 行已存在意味着已走过 spawn first realId 确认,
      //   NEW 行 cli_session_id 已是正确 realId — 不能被 OLD 覆盖 (违反 D2 不变量 2)
      //
      // 修法:**保留 NEW 行已有 cli_session_id 不覆盖** — 显式跳过 UPDATE。
      // 推理:rename 是 OLD 整迁到 NEW;cli_session_id 这一列由 NEW 自己维护(因为 NEW 是真
      // 跑 SDK / CLI thread 的那个);OLD 的 cli_session_id 历史值在反向 rename 路径下不需保留
      // (反向 rename 路径走 sessionManager.updateCliSessionId 单列 UPDATE + 黑名单链,
      // 不走本 rename helper 的 toExists=true 分支)。
      // **不调** db.prepare UPDATE — 显式跳过 (注释明示防 future regression 误加 UPDATE)。
    }
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(fromId);
  });
  tx();
}
