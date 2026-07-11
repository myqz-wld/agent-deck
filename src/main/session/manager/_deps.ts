/**
 * SessionManager 拆分共享 types / helpers SSOT(Step 4.6 — plan deep-project-review-comprehensive-20260528)。
 *
 * 4 文件布局: facade `manager.ts` + 本 `_deps.ts` + `lifecycle.ts` + `rename.ts`。
 *
 * 本文件持有:
 * - SessionCloseFn / SessionRenameHookFn type SSOT(facade 声明 module-level let + sub-module
 *   通过本 interface deps 拿当前值)
 * - SessionManagerInternalState interface — facade class 暴露给 sub-module free function 的
 *   internal state Map ref(recentlyDeleted 黑名单)
 * - RECENTLY_DELETED_TTL_MS 常量(60s)
 * - LifecycleDeps / RenameDeps interfaces(test seam,默认走真 sessionRepo / mcpSessionTokenMap /
 *   eventBus / applyClosedSideEffects / archiveTeams* / leaveTeams* / sessionCloseFn /
 *   sessionRenameHookFn)
 * - isRecentlyDeletedImpl free function(lifecycle 与 ingest 共享)
 *
 * **真私有 `#sdkOwned` 约束**: ECMAScript private field `#sdkOwned` 不在本 interface 内 —
 * 跨文件不可访问,由 facade class method 内部直接 mutate(sdk-claim 5 method + renameSdkSession
 * `#sdkOwned` transfer 段都在 class 内,不出去)。free function 仅当前 lifecycle / rename 域
 * 不需读 sdkOwned,本 interface 不提供 accessor。pipeline 仍走 IngestContext facade
 * (manager-ingest-pipeline.ts SSOT)。
 *
 * **软私有 Map 暴露**: pendingSdkCwds 仅 sdk-claim 5 method 用全留 class 内,不出去;
 * recentlyDeleted 是 TypeScript `private` Map 字段,lifecycle (delete / markRecentlyDeleted) /
 * rename (renameSdkSession / updateCliSessionId) free function 需 mutate,通过本 interface 拿 ref。
 */

import type { SessionSource } from '@shared/types';

/**
 * SessionManager 不直接 import adapterRegistry(避免反向依赖 + 单职责),
 * 启动时 index.ts 通过 setSessionCloseFn 注入「按 sessionId 关 SDK 侧 live query」的 hook。
 * delete() 调用前者,让 SDK bridge 同步 abort + 清 internal session 与 pending Maps(CHANGELOG_20 / N2)。
 */
export type SessionCloseFn = (agentId: string, sessionId: string) => Promise<void>;

/**
 * plan codex-handoff-team-alignment-20260518 P2 Step 2.8 / 不变量 7:rename 同步必须在
 * `sessionManager.renameSdkSession` 函数体内统一调(与 sdkOwned 转移同款保证),不能让
 * caller(codex bridge thread-loop / sdk-bridge recoverer)各自调(漏调风险)。
 *
 * SessionManager 不直接 import 各 adapter bridge(避免反向依赖 + 单职责),main bootstrap
 * 通过 setSessionRenameHookFn 注入「按 agentId 派发 rename hook」回调,让 SessionManager
 * 在 renameSdkSession 函数体末尾同步调到 bridge.renameCodexInstance / 其他 adapter 的同款
 * method(claude adapter 走 in-process MCP transport,closure override,不需 token map rename,
 * hook 可以 noop)。
 *
 * 同步执行(不走事件订阅):renameSdkSession 调用方依赖 rename 完成后立即看到一致的
 * sdkOwned + token map + per-session bridge instance map 三处 key 同步迁移。
 */
export type SessionRenameHookFn = (agentId: string, fromId: string, toId: string) => void;

/**
 * 创建 / 更新 SessionRecord 的入参契约。export 是为 manager-ingest-pipeline.ts
 * 的 IngestContext.ensure 签名共享类型(CHANGELOG_86 Step 4.3.3 facade 契约)。
 */
export interface UpsertOptions {
  agentId: string;
  cwd?: string;
  title?: string;
  source?: SessionSource;
  reviveClosed?: boolean;
}

/**
 * SessionManager internal state — sub-module free function 通过本 interface 拿
 * recentlyDeleted Map ref + 直接 mutate(lifecycle / rename / 黑名单 helper 共享)。
 *
 * **设计意图**: 不传 `this`(class 实例)给 free function,避免 sub-module cast `(state as any).#sdkOwned`
 * 试图绕过真私有 (cast 路径 #sdkOwned 不可达,返 undefined)。本 interface 仅暴露需要的 Map ref,
 * 保 free function 单一职责。
 */
export interface SessionManagerInternalState {
  /**
   * 黑名单 Map<sessionId, deletedAt>。
   *
   * - **key 语义**(R5 MED-R5-1 双写升级): 双写 {applicationSid, cliSessionId} 后两 key 都能命中
   *   isRecentlyDeleted 检查;反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包用 cliSid 来。
   * - **TTL**: 60s(`RECENTLY_DELETED_TTL_MS`,远大于任何 SDK 收尾延时,但又不长到无意义占内存)
   * - **mutate 入口**: lifecycle.markRecentlyDeletedImpl(双写) / lifecycle.deleteImpl(双写) /
   *   rename.renameSdkSessionImpl(单写 fromId) / rename.updateCliSessionIdImpl(单写 oldCliSid)
   */
  recentlyDeleted: Map<string, number>;
  /**
   * close-epoch 计数器 Map<sessionId, count>(REVIEW_99 R3 carry-forward cancellation-epoch 方案)。
   *
   * **动机**: closed 会话被用户合法 resume → recover 入口 emit user message(source:'sdk')经
   * ensure closed→active 复活 → 续接上下文准备 / createSession 内部
   * pre-registration await 期间用户**再次** close → 旧 `closed && !wasClosed` lifecycle 快照判定
   * 漏掉「恢复期间第二次 close」(wasClosed=true 让条件恒 false)→ 反转用户显式 close 起 fresh CLI。
   * epoch 是「close 动作发生过没有」的直接信号,不是「当前 lifecycle 是不是 closed」的快照推断。
   *
   * - **自增入口**(close intent 起点): lifecycle.closeImpl(adapter close 前) /
   *   lifecycle.markClosedImpl(transition guard 后,覆盖 scheduler 衰减 / rollback / 非 UI close) /
   *   lifecycle.deleteImpl(起点)。**markDormant 不自增**(dormant 可恢复非 close intent)。
   * - **读取入口**: facade.getCloseEpoch → recover 入口捕获 baseline + 多检查点比对(jsonl-fallback
   *   await 后 + createSession pre-registration await 后)。
   * - **delete 清理**: deleteImpl 末尾删 entry 防 Map 随删除会话无界增长 — 安全因 recover guard
   *   record-missing 分支(`!sessionRepo.get(sid)`)兜底捕获 delete(sessionRepo.delete 后 row 即 null)。
   */
  closeEpoch: Map<string, number>;
}

/** 黑名单 TTL — 与 manager.ts:123 RECENTLY_DELETED_TTL_MS 同款常量。 */
export const RECENTLY_DELETED_TTL_MS = 60_000;

/**
 * 黑名单 TTL 检查:超时自动从 Map 删,避免 ingest 路径累积无效 entry。
 *
 * 拆自 manager.ts:280 SessionManagerClass.isRecentlyDeleted private method,改为 free function
 * 接 SessionManagerInternalState ref。manager.ts ingest 入口 (3b) + lifecycle delete 路径
 * 共享。
 */
export function isRecentlyDeletedImpl(
  state: SessionManagerInternalState,
  sessionId: string,
): boolean {
  const at = state.recentlyDeleted.get(sessionId);
  if (at === undefined) return false;
  if (Date.now() - at > RECENTLY_DELETED_TTL_MS) {
    state.recentlyDeleted.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * close intent 起点自增 close-epoch(REVIEW_99 R3 cancellation-epoch)。
 *
 * closeImpl / markClosedImpl / deleteImpl 各自在 close intent 起点调本 helper,让
 * recover guard 的 `getCloseEpoch(sid) !== baseline` 比对能感知「close 动作发生过」。
 * Map.get(sid) ?? 0 兜首次自增到 1(baseline 捕获时若 session 从未 close 过 getCloseEpoch
 * 返 0,first close 后变 1 → guard 命中)。
 */
export function bumpCloseEpochImpl(
  state: SessionManagerInternalState,
  sessionId: string,
): void {
  state.closeEpoch.set(sessionId, (state.closeEpoch.get(sessionId) ?? 0) + 1);
}

/**
 * 读 close-epoch 当前值(REVIEW_99 R3 cancellation-epoch)。未 close 过返 0。
 *
 * recover 入口 emit user message **之后**捕获 baseline(emit 触发 revive 不算 close,且
 * emit 前 baseline 会把旧 close 混进);多检查点(jsonl-fallback await 后 / createSession
 * pre-registration await 后)比对 `getCloseEpoch(sid) !== baseline` 判 cancel。
 */
export function getCloseEpochImpl(
  state: SessionManagerInternalState,
  sessionId: string,
): number {
  return state.closeEpoch.get(sessionId) ?? 0;
}
