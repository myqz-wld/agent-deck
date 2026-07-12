/**
 * SessionManager rename 域 free function(拆自 manager.ts — Step 4.6
 * plan deep-project-review-comprehensive-20260528)。
 *
 * 2 个 free function 对应 SessionManagerClass 同名 method:
 * - renameSdkSessionImpl — SDK 通道 sid 切换(tempKey → realId / fork OLD→NEW / bypass 冷切)
 * - updateCliSessionIdImpl — 反向 rename:仅 UPDATE sessions.cli_session_id 单列
 *
 * **真私有 `#sdkOwned` callback 模式**:renameSdkSession 内 `#sdkOwned` mutate 由 facade class
 * method 通过 `transferSdkClaim` callback 传入本 free function,在合适位置(sessionRepo.rename 后 +
 * 黑名单写前)调用。保 6 步顺序 byte-identical 与原 manager.ts ①sessionRepo.rename ②sdkOwned transfer
 * ③黑名单 ④tokenMap rename ⑤emit session-renamed ⑥emit upserted + hook 一致。
 *
 * **N1 失败处理**: hook 失败 console.error prominent (codex agent 必须经 hook 才能保 4-key 一致;
 *   claude agent 不需 hook,silent 跳过)。
 */
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type { SessionManagerInternalState, SessionRenameHookFn } from './_deps';
import log from '@main/utils/logger';
import { handOffCutoverCoordinator } from '../hand-off/cutover-coordinator';

const logger = log.scope('session-manager-rename');

/**
 * 把 fromId 的 sessions 行 + 子表引用整体迁到 toId(保留所有事件 / 文件改动 / 总结),然后通知
 * renderer 同步迁移 selectedId / by-session 状态(拆自 manager.ts:550 renameSdkSession)。
 *
 * 用于 SDK fallback 路径:tempKey 占位 → 真实 session_id 出现后无损切换,用户保持在 detail,
 * 不被踢回主界面。
 *
 * REVIEW_7 M3:sdkOwned claim 由本函数原子转移(fromId → toId),调用方不再手工管。旧版调用方需在
 * rename 前后自己 release(fromId) + claim(toId);fork 路径只 release 不 claim 时 NEW_ID 未被
 * sdkOwned 覆盖,window 期间 hook 通道抢先 NEW_ID 事件会走「未 claim」分支造另一条 record
 * (虽然概率极低)。内聚后所有调用方拿到同一保证。
 *
 * **6 步顺序 byte-identical 与原 manager.ts:550 一致**(callback transferSdkClaim 在 sessionRepo.rename
 * 后 + 黑名单写前调用):
 * 1. sessionRepo.rename(fromId, toId) — DB 行迁移(INSERT NEW + DELETE OLD)
 * 2. transferSdkClaim() — `#sdkOwned` 真私有 mutate(facade class method callback,真私有约束跨文件
 *    不可访问)
 * 3. recentlyDeleted.set(fromId, Date.now()) — 黑名单写 OLD_ID 60s,挡 SDK 子进程异步飞回的迟到
 *    hook event(典型 approve-bypass 冷切场景 SIGTERM 后还在飞 SessionEnd hook)
 * 4. mcpSessionTokenMap.rename(fromId, toId) — token map rename(claude adapter 路径走 in-process MCP
 *    transport closure override 不消费 token map,oldSid 不在 map 时 noop 静默 — 不影响 claude 路径)
 * 5. eventBus.emit('session-renamed', { from, to }) — 通知 renderer 同步迁移 historySession.id /
 *    selectedId / by-session 状态(App.tsx 单独 listen onSessionRenamed)
 * 6. eventBus.emit('session-upserted', updated) + sessionRenameHookFn 派发 — 桥点 codex bridge.
 *    renameCodexInstance 同步 rename codexBySession Map key(claude bridge hook noop 不消费)
 *
 * **P5 Round 1 reviewer-codex M2 修法 (4-key 原子性加固)**:
 * hook 缺失或抛错时 sessions Map / sdkOwned / token map 已迁移完 + DB rename 已成,但 codexBySession
 * Map key 仍指向 fromId — 后续 sendMessage(toId) 走 ensureCodex 命中 miss → 重建 Codex 实例;旧
 * Codex 实例 stale 在 codexBySession[fromId] 等下次 close 清。属轻微 leak 不致命,但 codex agent
 * session 必须经 hook 才能保 4 keys 一致。codex agent + hook 缺失 = 严重 bug → console.error
 * prominent 让 operator 看到(而非 silently warn)。claude agent 不需 hook → silent 跳过保留语义。
 */
export function renameSdkSessionImpl(
  state: SessionManagerInternalState,
  fromId: string,
  toId: string,
  sessionRenameHookFn: SessionRenameHookFn | null,
  callbacks: { transferSdkClaim: () => void },
): void {
  // ① DB 行 rename(INSERT NEW + DELETE OLD)
  sessionRepo.rename(fromId, toId);
  handOffCutoverCoordinator.renameSource(fromId, toId);
  // ② `#sdkOwned` 真私有 mutate(facade class method callback)
  callbacks.transferSdkClaim();
  // ③ 黑名单写 OLD_ID 60s,挡迟到 hook event
  state.recentlyDeleted.set(fromId, Date.now());
  // ④ token map rename(claude 路径 noop 静默)
  mcpSessionTokenMap.rename(fromId, toId);
  // ⑤ emit session-renamed
  eventBus.emit('session-renamed', { from: fromId, to: toId });
  // ⑥ emit upserted + hook 派发
  const updated = sessionRepo.get(toId);
  if (updated) {
    eventBus.emit('session-upserted', updated);
    if (updated.agentId === 'codex-cli' && !sessionRenameHookFn) {
      logger.error(
        `[sessionManager] CRITICAL: rename(${fromId} → ${toId}) for codex-cli agent but sessionRenameHookFn not registered. ` +
          `codexBySession Map will be stale (entry kept under fromId). main/index.ts bootstrap step 5.1.1 must call setSessionRenameHookFn before any codex spawn. ` +
          `Continuing with 3-key rename (DB / sdkOwned / token map) — codex Codex instance leak until session closeSession.`,
      );
    }
    if (updated.agentId && sessionRenameHookFn) {
      try {
        sessionRenameHookFn(updated.agentId, fromId, toId);
      } catch (err) {
        logger.error(
          `[sessionManager] rename hook for ${updated.agentId} ${fromId} → ${toId} threw — ` +
            `4-key sync degraded to 3 keys (DB / sdkOwned / token map migrated, codexBySession stale). ` +
            `Stale codex instance leaked until next closeSession; downstream sendMessage(${toId}) will rebuild via ensureCodex.`,
          err,
        );
      }
    }
  }
}

/**
 * 反向 rename:仅 UPDATE sessions.cli_session_id 单列(不动 sessions.id 应用稳定身份)
 * (拆自 manager.ts:649 updateCliSessionId)。
 *
 * plan reverse-rename-sid-stability-20260520 §A.4 / §设计决策 D5 / §不变量 2 + 5。
 *
 * **关键 invariant** (与 renameSdkSession 跨表事务复杂迁移**完全不同**):
 * - sessions.id 不变(applicationSid 是应用稳定身份,不变量 1)
 * - 仅 cli_session_id 列变化(允许 6 处反向 rename 路径,不变量 2)
 * - **不**触发 session-renamed event(D6 line 92 反向 rename 不 emit,renderer listener 不触发)
 * - **不**调 mcpSessionTokenMap.rename(token map 用 sessions.id 做 key,sessions.id 不变 → token 永远稳定)
 * - **不**触发 sessions Map / SDK claim mutate(applicationSid 不变,bridge S3 isNewSpawn 分支保护已让 fork detect 路径只 update internal.cliSessionId)
 *
 * **黑名单链** (R5 HIGH-R5-1 + R6 MED-R6-1 修订):
 * - 读 oldCliSid = sessionRepo.get(applicationSid)?.cliSessionId ?? applicationSid (兜底防 null)
 * - 调 sessionRepo.updateCliSessionId(applicationSid, newCliSid) 单列 UPDATE
 * - 调 recentlyDeleted.set(oldCliSid, Date.now()) 加 OLD_CLI 黑名单 60s
 *   防迟到 hook event 携带 OLD_CLI 时撞 D7 3b miss 复活幽灵 record
 *
 * **caller 必须经本 helper 包装,不能直接调 sessionRepo.updateCliSessionId** (否则黑名单链断,
 * R7 MED-R7-2 test 6 已加断言 verify)。
 *
 * **spawn-path no-op 短路** (REVIEW_49 R3 follow-up LOW): spawn 主路径下 oldCliSid ===
 * applicationSid === newCliSessionId,L632 `oldCliSid !== newCliSessionId` 判断不写黑名单 →
 * 行为等价直调 sessionRepo.updateCliSessionId。统一走 wrapper 是契约层硬约束 SSOT;不要因
 * 「spawn 路径反正等价」而在 caller 处直调 sessionRepo,会让未来 fork 路径误传不同
 * cliSessionId 时静默跳过黑名单写入(blame radius 隐蔽 + 复活 ghost record 风险)。
 *
 * 调用方 (6 处反向 rename 路径,详 plan §D2 表):
 * - recoverer.ts:466 jsonl-missing fallback (claude)
 * - codex/recoverer.ts:339 jsonl-missing fallback (codex)
 * - stream-processor.ts:313 fork detect (claude)
 * - codex/thread-loop.ts:263 case 3 post-resume fork (codex,future-proof)
 * - restart-controller.ts:189 restartWithPermissionMode (claude)
 * - restart-controller.ts:341 restartWithClaudeCodeSandbox (claude)
 *
 * 调用方 (spawn 主路径,新增 R2 reviewer-claude MED 修法):
 * - claude-code/sdk-bridge/session-finalize.ts:98 spawn 主路径 cli_session_id 写入
 *   (spawn 时 oldCliSid === newCliSessionId === applicationSid,wrapper 内 L632 不写
 *   黑名单语义等价直调 sessionRepo;统一走 wrapper 让契约层硬约束 SSOT 不被绕过)
 */
export function updateCliSessionIdImpl(
  state: SessionManagerInternalState,
  applicationSid: string,
  newCliSessionId: string,
): void {
  const rec = sessionRepo.get(applicationSid);
  const oldCliSid = rec?.cliSessionId ?? applicationSid;
  sessionRepo.updateCliSessionId(applicationSid, newCliSessionId);
  // OLD_CLI 进黑名单 60s — 防迟到 hook event 携带 OLD_CLI 复活幽灵 record (D7 3b ingest drop)
  if (oldCliSid && oldCliSid !== newCliSessionId) {
    state.recentlyDeleted.set(oldCliSid, Date.now());
  }
  // 不 emit session-renamed (D6 反向 rename 不 emit)
  // 不调 mcpSessionTokenMap.rename (token map key = sessions.id 不变)
  // 不调 sessionRenameHookFn (codex bridge 不需 rename codexBySession Map key — applicationSid 不变)
}
