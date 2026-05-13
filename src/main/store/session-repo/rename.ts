/**
 * session-repo —— rename（最复杂的跨表迁移操作）。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 */

import { getDb } from '../db';
import type { Row } from './types';

/**
 * 把 sessions 表里 fromId 改名 toId，并把 events / file_changes / summaries
 * 的 session_id 引用一起迁移。整体在事务内做，避免外键 CASCADE 误删历史。
 * 用于 SDK fallback：tempKey 占位行 → 真实 session_id 出现后无损迁移。
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
 * plan team-cohesion-fix-20260513 Phase A Step A9：team_name 列已 v014 drop，
 * rename 路径不再需要复制 team_name 字段。team 关系由 universal team backend
 * (agent_deck_team_members) 维护，session_id 改名时需调 sessionManager.delete
 * 路径的 leaveTeam 兜底（已实现），或 rename 后由 caller 自行 leaveTeam(OLD) +
 * addMember(NEW)。
 */
export function rename(fromId: string, toId: string): void {
  if (fromId === toId) return;
  const db = getDb();
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
      db.prepare(
        `INSERT INTO sessions
         (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, codex_sandbox, claude_code_sandbox, spawned_by, spawn_depth, generic_pty_config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        fromRow.spawned_by,
        fromRow.spawn_depth,
        fromRow.generic_pty_config,
      );
    }
    // 迁移子表引用（外键 ON DELETE CASCADE 在删 fromId 时不会误删，因为 session_id 已改）
    db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE file_changes SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE summaries SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
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
    if (toExists && fromRow.spawn_depth > 0) {
      db.prepare(`UPDATE sessions SET spawn_depth = ? WHERE id = ?`).run(fromRow.spawn_depth, toId);
    }
    if (toExists && fromRow.generic_pty_config) {
      // R4·F2：generic-pty / aider session 的 spawn config 是会话身份相关字段，
      // recoverAndSend / SDK fallback rename 时必须从 fromRow 覆盖到 NEW 行，
      // 否则 lifecycle 复活路径丢失 config，resume 按错 args 重 spawn（与 codex_sandbox 同模式）。
      db.prepare(`UPDATE sessions SET generic_pty_config = ? WHERE id = ?`).run(
        fromRow.generic_pty_config,
        toId,
      );
    }
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(fromId);
  });
  tx();
}
