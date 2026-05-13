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

export function buildHandOffCreateSessionOpts(
  session: SessionRecord,
  finalPrompt: string,
): CreateSessionOptions {
  return {
    cwd: session.cwd,
    prompt: finalPrompt,
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    ...(session.codexSandbox ? { codexSandbox: session.codexSandbox } : {}),
    ...(session.claudeCodeSandbox ? { claudeCodeSandbox: session.claudeCodeSandbox } : {}),
  };
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

