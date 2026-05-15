/**
 * Hand-off SDK session 创建 opts 拼装 + inflight dedup helper（REVIEW_33 H6 / H7）。
 *
 * 抽到独立 file 是为了让 unit test 可以纯 import 不触发 sessions.ts 的 Electron / IPC
 * register 副作用链（sessions.ts import 链含 sessionManager / sessionRepo /
 * eventBus 等 Electron 依赖，单测 import 整个 module 会拉起 Electron 加载报错）。
 *
 * **buildHandOffCreateSessionOpts**（H6）：与原 session 完全对齐 cwd / permissionMode /
 * codexSandbox / claudeCodeSandbox 四字段（前三个 H6 修前漏，导致用户切到 read-only 后
 * hand-off 起的新 session 落 settings 全局默认 = 隐性沙盒 downgrade）。条件透传规则与
 * permissionMode 对称：字段为 null/undefined 时不写 opts → adapter 收到 undefined 走
 * settings 全局值 fallback（保持 codex-cli / claude-code adapter 既有行为）。
 *
 * **handOffInflight**（H7）：按 sourceSid 复用 in-flight Promise，挡 IPC handler 端
 * race —— renderer ref guard 是第一道闸（同步 ref 比 React state 快 16-200ms），但
 * IPC 通道仍可能因为多 renderer 实例 / 历史 race 让同 sourceSid 同时进入 handler
 * 两次。main 端 inflight Map 是兜底闸：第二次 IPC 等第一次 in-flight Promise resolve
 * 拿同 newSid 返回（双方都拿到同 sid，UI 状态一致）。Promise 完成（无论 resolve 或 reject）
 * 自动 delete entry，下次同 sourceSid 仍可正常起新 hand-off。
 */
import type { SessionRecord } from '@shared/types';
import type { CreateSessionOptions } from '@main/adapters/types';
import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import { SessionRowMissingError } from '@main/store/session-repo';

export function buildHandOffCreateSessionOpts(
  session: SessionRecord,
  finalPrompt: string,
): CreateSessionOptions {
  // p4-d2-impl Step 2.2：用 buildCreateSessionOptions builder helper 按 session.agentId
  // narrow 到对应 union arm（filter 掉不属本 adapter 的字段，TS 编译期阻止字段误传）。
  // session.agentId 是 SessionRecord.agentId: string，走 string overload 内部 isAgentId
  // guard，invalid throw（caller 端 sessions.ts:113 已先 sessionRepo.get 验过 session 存在
  // + line 156 验 adapter.createSession 存在，到此 session.agentId 应都是合法 union 成员）。
  return buildCreateSessionOptions(session.agentId, {
    cwd: session.cwd,
    prompt: finalPrompt,
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    ...(session.codexSandbox ? { codexSandbox: session.codexSandbox } : {}),
    ...(session.claudeCodeSandbox ? { claudeCodeSandbox: session.claudeCodeSandbox } : {}),
  });
}

/**
 * archive-failure-ux-upthrow-20260515 plan: K3 SessionHandOffSpawn archive 失败 UX 上抛 helper。
 *
 * 抽到本 helper 是为了让 K3 emit schema 有 unit test 守门(sessions.test.ts 不能 import sessions.ts
 * 整套 Electron 链 — sessionManager / sessionRepo / eventBus / dedupHandOff 拉起报错)。本 helper
 * 走纯 deps inject(无 default 实现),caller 必传真 archiveFn + emitFn + getSessionFn。
 *
 * **K3 与 mcp baton-cleanup 区别**: K3 走独立 sessionManager.archive(sid) 不经 baton-cleanup
 * helper(K3 是用户 UI 触发的 hand-off,不通过 mcp tool,但 archive 失败 UX 上抛语义需对齐)。
 *
 * **R2 reviewer-codex MED-1 修法**: K3 也加 row-missing 探针(与 mcp baton-cleanup 同款)。
 * 原 R1 修法假设「K3 进入 try 前已 sessionRepo.get 验证 session 存在(sessions.ts:117),
 * 不可能走 row-missing 路径」**结论错误** —— sessions.ts:117 探针发生在 createSession 之前,
 * 而 createSession 是 long-running async,期间 source row 可能被其它 path(lifecycle scheduler /
 * 用户手动 close / DB reaper)清理掉。`sessionRepo.setArchived` (archive.ts:19) 是裸
 * `UPDATE sessions SET archived_at = ? WHERE id = ?` 不检查 .changes,对缺失 row 是 silent
 * resolve;`sessionManager.archive` (manager.ts:296-306) 也不抛错对缺失 row。结果: archive
 * 走 happy path 不 emit,用户不知道 source row 已被异常清理。修法: archive 前重新探针 row,
 * 不存在则 emit reasonKind='row-missing' 跳过 archive,与 mcp baton-cleanup 行为对齐。
 */
export interface ArchiveSourceSessionDeps {
  archive: (sid: string) => Promise<void>;
  /**
   * R2 reviewer-codex MED-1 修法新增: archive 前重新探针 source row(K3 createSession 是
   * long-running async,row 可能在期间被删 → archive UPDATE no-op silent resolve → 漏 emit)。
   * 返回 null 即视为 row-missing 短路 emit row-missing 不调 archive。
   */
  getSession: (sid: string) => unknown | null;
  /**
   * Emit `caller-archive-failed` event payload(schema 与 event-bus.ts EventMap 同 — 编译期 tsc
   * 检查在 sessions.ts handler 调用处用 `satisfies EventMap['caller-archive-failed'][0]`)。
   *
   * R2 reviewer-codex MED-1 修法: reasonKind 从单一 'archive-throw' 改成 union 含 'row-missing'
   * 与 mcp baton-cleanup 对齐 (event-bus.ts EventMap 已是 union)。
   *
   * archive-toctou-fix-20260515 plan: reasonKind 加 'probe-throw' (DB probe 异常,可重试),让 UI
   * 三档区分(row-missing 仅告知 / probe-throw + archive-throw 显示「重试归档」按钮)。
   */
  emitArchiveFailed: (payload: {
    sessionId: string;
    toolName: 'SessionHandOffSpawn';
    reason: string;
    reasonKind: 'row-missing' | 'probe-throw' | 'archive-throw';
  }) => void;
}

/**
 * 归档原 session + archive 失败上抛 'caller-archive-failed' event。失败仅 warn 不抛(与 sessions.ts
 * 历史语义一致 — archive 失败不阻塞 hand-off ok return,用户至少能切到新 session 工作)。
 *
 * R2 reviewer-codex MED-1 修法: archive 前重新探针 source row,缺失 → emit row-missing 短路
 * (与 mcp baton-cleanup 同款 ground truth 探针)。
 */
export async function archiveSourceSessionWithEmit(
  sid: string,
  deps: ArchiveSourceSessionDeps,
): Promise<void> {
  // R2 reviewer-codex MED-1 修法: archive 前重新探针 row。createSession 是 long-running async,
  // 期间 source row 可能被异常清理 (lifecycle scheduler / 用户手动 close / DB reaper)。
  // sessionManager.archive 对缺失 row 是 silent no-op (UPDATE 不查 .changes),漏 emit 用户感知不到。
  // 重新探针保证 ground truth,与 mcp baton-cleanup helper 行为对齐。
  // archive-toctou-fix-20260515 plan: probe try/catch 拆 'probe-throw' 独立 reasonKind (DB 异常
  // 可重试,与 row 真不存在的 'row-missing' 区分),与 mcp baton-cleanup 行为对齐;archive try/catch
  // 内 instanceof SessionRowMissingError 区分 setter no-op (race window) vs 真 archive 异常,准确
  // 反射 reasonKind 给 UI 而非 catch-all 误归 'archive-throw' 误导用户(LOW probe-throw bug + R1
  // reviewer-codex MED-1)。
  let row: unknown | null = null;
  let probeError: { reason: string } | null = null;
  try {
    row = deps.getSession(sid);
  } catch (e) {
    // archive-toctou-fix-20260515 plan: probe 抛错独立分支 — DB 异常 (SQLite locked / read failure)
    // 状态未知 row 可能仍存在,与 row 真不存在的 'row-missing' 区分。reasonKind='probe-throw' 让 UI
    // 显示「重试归档」按钮。修前吞错归 row-missing 隐藏 UI 重试入口。
    const errStr = e instanceof Error ? e.message : String(e);
    probeError = { reason: `probe getSession threw for ${sid}: ${errStr}` };
  }
  if (probeError) {
    console.warn(`[ipc sessions hand-off] ${probeError.reason}`);
    deps.emitArchiveFailed({
      sessionId: sid,
      toolName: 'SessionHandOffSpawn',
      reason: probeError.reason,
      reasonKind: 'probe-throw',
    });
    return;
  }
  if (!row) {
    const reason = `cannot archive caller ${sid}: not in sessions table (createSession 期间被异常清理)`;
    console.warn(`[ipc sessions hand-off] ${reason}`);
    deps.emitArchiveFailed({
      sessionId: sid,
      toolName: 'SessionHandOffSpawn',
      reason,
      reasonKind: 'row-missing',
    });
    return;
  }
  try {
    await deps.archive(sid);
  } catch (err) {
    // archive-toctou-fix-20260515 plan: 用 instanceof SessionRowMissingError 区分 setArchived no-op
    // (race window: probe OK 后 row 被外部删) vs 真 archive 异常 (FK constraint / DB locked / etc)。
    // 修前 catch-all 把 setter no-op 误归 'archive-throw' (UI 显示「重试归档」误导:row 真不存在
    // 重试无效),修后 instanceof 判别准确反射 reasonKind (R1 reviewer-codex MED-1 修法)。
    const isRowMissing = err instanceof SessionRowMissingError;
    const errStr = err instanceof Error ? err.message : String(err);
    const reason = isRowMissing
      ? `cannot archive caller ${sid}: ${errStr} (race window: probe OK 后 setArchived no-op)`
      : `archive caller ${sid} failed: ${errStr}`;
    console.warn(
      `[ipc sessions hand-off] ${
        isRowMissing
          ? `archive source session ${sid} setArchived no-op (race window)`
          : `archive source session ${sid} failed`
      }:`,
      err,
    );
    deps.emitArchiveFailed({
      sessionId: sid,
      toolName: 'SessionHandOffSpawn',
      reason,
      reasonKind: isRowMissing ? 'row-missing' : 'archive-throw',
    });
  }
}

/**
 * REVIEW_33 H7：sourceSid → in-flight hand-off Promise 单飞 Map。
 *
 * 用法：
 * ```
 * const existing = handOffInflight.get(sid);
 * if (existing) return await existing; // 复用 in-flight，避免起两个 SDK 子进程
 * const p = doActualHandOff(...);
 * handOffInflight.set(sid, p);
 * try { return await p; } finally { handOffInflight.delete(sid); }
 * ```
 *
 * 注意：导出可变 Map 是为了 unit test 能注入 / 清理；生产代码不应直接 mutate（仅
 * dedupHandOff helper 内部用）。
 */
export const handOffInflight = new Map<string, Promise<string>>();

/**
 * REVIEW_33 H7：dedupe wrapper —— 同 sourceSid 并发调用复用同一 in-flight Promise。
 *
 * @param sourceSid 原 session id（dedup key）
 * @param work 真正去起新 session 的工作函数；只在第一次进入时被调用
 * @returns 新 session id（双方都拿到同一个，UI 状态一致）
 */
export async function dedupHandOff(
  sourceSid: string,
  work: () => Promise<string>,
): Promise<string> {
  const existing = handOffInflight.get(sourceSid);
  if (existing) return existing;
  const p = work();
  handOffInflight.set(sourceSid, p);
  try {
    return await p;
  } finally {
    // 完成（resolve/reject）后清掉，下次同 sourceSid 仍可正常起新 hand-off。
    // 用 strict equal 保护，防 race 中第二次 dedupHandOff 的 set 覆盖了第一个 Promise
    // 后第一个 Promise resolve 时把第二个的 entry 误删（同 key 严格相等才删）。
    if (handOffInflight.get(sourceSid) === p) handOffInflight.delete(sourceSid);
  }
}

