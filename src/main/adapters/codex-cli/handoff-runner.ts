/**
 * Codex hand-off 接力简报 runner（plan model-wiring-and-handoff-20260514 Step 5.1）。
 *
 * 镜像 `summariseSessionForHandOff`（src/main/session/summarizer/llm-runners.ts:K3）但走 codex
 * SDK 自身 — 让 codex session 的 hand-off 简报由 codex 自己出，不再借用 claude SDK + sonnet
 * （详 plan Context 第 3 项）。
 *
 * 与 `summarizer-runner.ts:summariseCodexSessionViaOneshot` 同结构（复用 `ensureCodex()`），
 * 差异：
 * - prompt 改 4 节结构化模板（目标 / 已做 / 下一步 / 相关文件），与 claude hand-off 字面一致
 *   仅替换 "Claude" → "Agent"（与 summarizer-runner.ts:81-93 同款替换约定）
 * - `modelReasoningEffort: 'medium'`（hand-off 比 summarize 'low' 提一档保结构精度；high 太
 *   慢、low 结构化输出精度不够，medium 折中）
 * - 60s timeout（与 claude hand-off 平齐，参考 llm-runners.ts:213 注释）
 * - 返回 finalResponse trim 不限长度（hand-off 简报 4 节通常 800-2000 字，不像 30 字 tag-line
 *   要 slice 到 120 char）
 *
 * model 不显式传 — codex SDK startThread API 不接受 per-thread model override（runtime model
 * 由 ~/.codex/config.toml 顶层 `model` 决定）；plan D4 已说明，settings.handOffModel 对 codex
 * 路径无影响（仅对 claude session 生效）。
 *
 * 失败处理与 claude 同：caller (IPC handler) 接到 throw 后透传 → renderer modal inline error
 * 让用户重试或手动编辑兜底 prompt。本 runner 内只做 timeout race + result 收集，不做 fallback。
 */
import type { Codex } from '@openai/codex-sdk';
import type { AgentEvent } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { loadCodexSdk } from '@main/adapters/codex-cli/sdk-loader';
import { resolveBundledCodexBinary } from '@main/adapters/codex-cli/sdk-bridge/codex-binary';

let cachedCodex: Codex | null = null;
let cachedPath: string | null = null;

/**
 * 懒创建并缓存 codex 实例（与 summarizer-runner.ts:ensureCodex 完全字面对称 —— 同样不与
 * codex-cli adapter 的 bridge.ensureCodex 共享实例，hand-off 也是 read-only oneshot 用途，
 * 共享反而需要处理跨用途 lifecycle 协调，不值得）。
 *
 * settings.codexCliPath 改了 → 实例失效，下次 call 重建（与 summarizer 同 cachedPath 模式）。
 */
async function ensureCodex(): Promise<Codex> {
  const path = settingsStore.get('codexCliPath');
  const overridePath = (path && path.trim()) || resolveBundledCodexBinary();
  if (cachedCodex && cachedPath === overridePath) return cachedCodex;
  const sdk = await loadCodexSdk();
  cachedCodex = new sdk.Codex(overridePath ? { codexPathOverride: overridePath } : {});
  cachedPath = overridePath;
  return cachedCodex;
}

/**
 * 跑一次 codex hand-off 简报。`formatEvents` 由 ipc/sessions.ts 注入（与 summarizer 路径同款，
 * 避免在本 runner 重复维护 events → prompt 序列化逻辑 —— summarizer/index.ts 已有
 * formatEventsForPrompt 函数措辞精细）。
 *
 * @returns 4 节结构化简报；events 没有可总结内容 / codex 返回空 → null；超时 / codex 进程错 → throw
 */
export async function summariseCodexSessionForHandOff(
  cwd: string,
  events: AgentEvent[],
  formatEvents: (events: AgentEvent[]) => string,
): Promise<string | null> {
  const activity = formatEvents(events);
  if (!activity) return null;

  const codex = await ensureCodex();

  // 与 summarizer-runner.ts:70-76 同款约束（read-only 防 codex 真跑工具改文件、never approval
  // policy 不等审批、skipGitRepoCheck 跳 codex 默认 git repo 校验）。
  // **modelReasoningEffort 提到 'medium'**：hand-off 4 节结构化输出对 codex 理解力要求比
  // 30 字 summarize 高；high 太慢（spike 实测 30s+），low 输出结构常常错位（漏节 / 节标题
  // 写错），medium 是 spike-A3 实测下的最佳折中。
  const thread = codex.startThread({
    workingDirectory: cwd || process.cwd(),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    modelReasoningEffort: 'medium',
  });

  // prompt 与 claude `summariseSessionForHandOff` 字面一致 — 仅按 summarizer-runner.ts:81-93
  // 的同款约定把 "Claude" → "Agent"（marker `[Claude 说]` 等保留，是 formatEventsForPrompt 固
  // 定写法不本地化）。
  const prompt = `下面是某个 AI 助手会话最近的活动记录。**所有事件都是 Agent（AI 助手）一侧的行为**：
- [Claude 说] = Agent 自己说的话
- [Claude 调用工具] = Agent 在调用工具
- [Claude 主动询问用户] = Agent 用 AskUserQuestion 在向用户提问
- [Claude 改动文件] / [Claude 请求工具权限] = 字面意思

请基于这些事件生成一份「接力简报」，让另一个新 session agent 能接着干活。

会话 cwd：${cwd || '(未知)'}
最近活动（按时间从早到晚）：
${activity}

请用以下严格格式输出，**不要 Markdown code block 包裹、不要任何前后缀**：

【目标】
<提炼会话主线在解决什么问题 / 完成什么任务，1-3 句>

【已做】
- <具体已完成的步骤 1>
- <具体已完成的步骤 2>
- ...（5-10 条，按时序）

【下一步】
- <未完成 / 待续 / 下一步该做什么 1>
- <未完成 / 待续 / 下一步该做什么 2>
- ...（2-5 条）

【相关文件】
- <绝对路径 1>
- <绝对路径 2>
- ...（最多 10 个，从 [Claude 改动文件] / [Claude 调用工具] Edit/Read/Write 中提）

输出后请直接返回，**不要调用任何工具**。`;

  // codex SDK thread.run 没有 q.interrupt() 等价物（同 summariseCodexSessionViaOneshot 注释）。
  // 60s timeout 走 Promise.race 兜底防 codex 卡住。race 输（timer 先 reject）→ 抛出让 caller
  // catch；codex 子进程仍在后台跑，最终被 codex SDK 进程退出回收（对 hand-off 一次性触发场景
  // 无副作用）。
  const timeoutMs = 60_000;
  let timeoutHandle: NodeJS.Timeout | null = null;
  const codexPromise = thread.run(prompt);
  // 提前 catch 吞 codex 后台错误防 unhandled rejection（与 summariseCodexSessionViaOneshot 同款）
  codexPromise.catch(() => undefined);

  let result;
  try {
    const timer = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('__codex_handoff_summary_timeout__')),
        timeoutMs,
      );
    });
    result = await Promise.race([codexPromise, timer]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const cleaned = result.finalResponse.trim();
  return cleaned || null;
}
