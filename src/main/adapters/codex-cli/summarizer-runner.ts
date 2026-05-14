/**
 * Codex SDK oneshot 总结 runner（CHANGELOG_<X> A3）。
 *
 * 与 claude SDK 路径（src/main/session/summarizer.ts:summariseViaLlm）同形态：
 * - 跑一次 codex.startThread + thread.run（不流式）
 * - sandboxMode='read-only'：禁止真实工具调用，避免总结过程改文件
 * - reasoning effort = 'low'：oneshot 不需要深思，省 token + 出字快
 * - 复用应用层全局 codex 实例（懒创建 + per-call 起新 thread，与 codex-cli adapter 隔离）
 *
 * spike-A3 实测：5 codex 并发 oneshot 复用 codex app-server 单例，总耗 10s + 单进程
 * ~44 MB RSS。与 claude SDK 同档资源消耗，summarizer 全局 maxConcurrent 不需分桶。
 *
 * 失败模式：
 * - codex 二进制缺失 → ensureCodex throw
 * - codex 子进程 spawn 失败 / 被 abort → thread.run 抛错
 * - codex 返回空 finalResponse → 返回 null（让上层走 fallback 路径）
 * - codex API 限流 / 超时 → 抛错让上层 catch（写 lastErrorBySession）
 *
 * 不实现超时：codex SDK 没有 q.interrupt() 等价物，单次 thread.run 不带 timeout 选项；
 * 应用层 timeout 走 Promise.race 即可（参考 claude summariseViaLlm 范式）。
 * 但 spike-A3 显示典型 oneshot 在 ~2s 内返回，超时风险低，本 runner 暂不实现 timeout。
 */
import type { AgentEvent } from '@shared/types';
import { getCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';

/**
 * R37 P1 Step 1.2 (G)：原 module-level cachedCodex / cachedPath / ensureCodex 已下沉到
 * `codex-instance-pool.ts` 应用全局 pool（与 sdk-bridge / handoff-runner 共享同一实例）。
 * 本 runner 直接调 `getCodexInstance()`，path 改变时 pool 内部 path 比较自动失效。
 */

/**
 * 跑一次 codex oneshot 总结。`formatEvents` 由 summarizer.ts 注入（避免在本 runner 重复
 * 维护 events → prompt 序列化逻辑——summarizer.ts 那边已有 formatEventsForPrompt 函数，
 * 措辞精细，不重复实现）。
 *
 * @returns 总结文本（≤120 字符）；events 没有可总结内容 / codex 返回空 → null
 */
export async function summariseCodexSessionViaOneshot(
  cwd: string,
  events: AgentEvent[],
  formatEvents: (events: AgentEvent[]) => string,
): Promise<string | null> {
  const activity = formatEvents(events);
  if (!activity) return null;

  const codex = await getCodexInstance();

  // codex 没有 plan/permission mode 概念；read-only sandbox 防止 codex 真跑工具改文件。
  // approvalPolicy='never' 让 codex 不要在 oneshot 中等待审批（虽然 read-only 下也没什么
  // 可审批的，双保险）。
  const thread = codex.startThread({
    workingDirectory: cwd || process.cwd(),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    modelReasoningEffort: 'low', // oneshot 不需深思，省 token 出字快
  });

  // prompt 与 claude summariseViaLlm 相同结构：列举近期事件类型，让模型一句话总结。
  // 措辞替换 "Claude" → "Agent"（codex 不是 Claude），但保留 [Claude 说] 等 marker 不变
  // ——marker 是给模型解读历史用的标签，不需要本地化（且 formatEventsForPrompt 已固定写）。
  const prompt = `下面是某个 AI 助手会话最近的活动记录。**所有事件都是 Agent（AI 助手）一侧的行为**：
- [Claude 说] = Agent 自己说的话
- [Claude 调用工具] = Agent 在调用工具
- [Claude 主动询问用户] = Agent 用 AskUserQuestion 在向用户提问（不是用户在问 Agent）
- [Claude 改动文件] / [Claude 请求工具权限] = 字面意思

请用一句简洁的中文（不超过 30 字）总结 Agent 当前正在做的核心任务。
直接输出这句描述，不要前缀、不要解释、不要 Markdown、不要调用任何工具。
**绝不能把 Agent 的动作写成"用户 …"** —— 用户的输入不在记录中。

会话目录：${cwd || '(未知)'}
最近活动：
${activity}`;

  // thread.run 是 runStreamed 的包装，内部 await 完整 turn 后返回 { finalResponse }。
  // 不流式：oneshot 总结不需要逐字渲染，等终态即可。
  const result = await thread.run(prompt);
  const cleaned = result.finalResponse.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}
