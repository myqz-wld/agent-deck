import type { AgentEvent } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { getSdkRuntimeOptions, getPathToClaudeCodeExecutable } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { formatEventsForPrompt } from './event-formatter';

/**
 * 用本地 OAuth + Claude Code SDK 跑一次 oneshot 总结。关键约束：
 * - settingSources: []   不读 ~/.claude/settings.json，避免 hook 回环到自己
 * - permissionMode: 'plan'  禁止真实工具调用，只让模型输出文字
 * - 一旦收到 result 就立刻 break，让 cli.js 子进程尽快退出
 *
 * 超时：底层 cli.js 子进程因代理超时 / 鉴权死锁 / API 限流卡在等待 result 时，
 * for-await 会永远不返回 → inFlight 槽永不释放，maxConcurrent 个卡死后整个
 * Summarizer 不再产新总结。用 Promise.race 给硬上限：
 * - 优先调 q.interrupt() 让 SDK 自己优雅退（清掉 cli.js 子进程）
 * - 兜底 throw '__summarizer_timeout__'，让外层 catch 走兜底路径（最近一条 assistant / 事件统计）
 */
export async function summariseViaLlm(cwd: string, events: AgentEvent[]): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity) return null;

  const sdk = await loadSdk();
  const runtime = getSdkRuntimeOptions();
  const claudeBinary = getPathToClaudeCodeExecutable();
  const prompt = `下面是某个 Claude Code 会话最近的活动记录。**所有事件都是 Claude（AI 助手）一侧的行为**：
- [Claude 说] = Claude 自己说的话
- [Claude 调用工具] = Claude 在调用工具
- [Claude 主动询问用户] = Claude 用 AskUserQuestion 在向用户提问（不是用户在问 Claude）
- [Claude 改动文件] / [Claude 请求工具权限] = 字面意思

请用一句简洁的中文（不超过 30 字）总结 Claude 当前正在做的核心任务。
直接输出这句描述，不要前缀、不要解释、不要 Markdown、不要调用任何工具。
**绝不能把 Claude 的动作写成"用户 …"** —— 用户的输入不在记录中。

会话目录：${cwd || '(未知)'}
最近活动：
${activity}`;

  const q = sdk.query({
    prompt,
    options: {
      cwd: cwd || process.cwd(),
      // 总结只一句话，用 haiku 足够：成本低、吐字快，多个会话排队也不会卡。
      // 模型优先级（plan model-wiring-and-handoff-20260514 Step 4.3）：
      //   1. settings.summaryModel（UI 暴露的字符串字段，'' 表示沿用下面 env / alias 链）
      //   2. settings.json 里配的 ANTHROPIC_DEFAULT_HAIKU_MODEL（具体 id）
      //   3. ANTHROPIC_MODEL（用户主模型，没配 haiku 但配了主模型时退而求其次）
      //   4. 'haiku' alias（让什么都没配的环境也能跑，由 SDK / CLI 自己解析）
      // applyClaudeSettingsEnv 在 bootstrap 时已把 settings.json 的 env 注入 process.env。
      // settingsStore.get 在 main 进程内可调（本函数跑在 main 进程，不是 SDK 子进程）。
      model:
        settingsStore.get('summaryModel') ||
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
        process.env.ANTHROPIC_MODEL ||
        'haiku',
      permissionMode: 'plan',
      systemPrompt:
        '你是一个会话观察助手。你看到的每一条事件都是 Claude（AI 助手）一侧的行为，' +
        '用户输入不会出现在记录里。基于这些事件用一句简短中文描述 Claude 当前任务。' +
        '不要把 Claude 的动作写成"用户 …"，不要调用工具，不要展开解释。',
      settingSources: [],
      // SDK 默认会 spawn 'node'，但 .app 走 launchd 启动时 PATH 不含 nvm/homebrew 的 node。
      // 用 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 复用内置 Node runtime，零依赖系统 node。
      executable: runtime.executable,
      env: runtime.env,
      // SDK 0.2.x 把 cli.js 拆成 native binary（platform-specific 包），SDK 内部
      // require.resolve 拿到的路径在 .app 里走 `app.asar/...`，spawn 走系统 syscall
      // 不经 Electron fs patch → ENOTDIR → summarizer LLM 100% 失败 → 全降级到事件统计。
      // 显式传解析后的 unpacked 路径绕开 SDK 自带 K7。详见 sdk-runtime.ts。
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
    },
  });

  const timeoutMs = settingsStore.get('summaryTimeoutMs');
  let timeoutHandle: NodeJS.Timeout | null = null;
  // REVIEW_35 LOW-B3：删 `let timedOut + if (timedOut) throw` 死代码（race winner 必走 throw
  // 路径，timedOut 变量从未被读）。timer 直接 reject 即可，外层 try/finally 异常传播完整。
  const consumeLoop = (async () => {
    let result = '';
    for await (const msg of q) {
      const m = msg as {
        type: string;
        message?: { content?: { type: string; text?: string }[] };
      };
      if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text) result += block.text;
        }
      }
      if (m.type === 'result') break;
    }
    return result;
  })();
  // 超时后 consumeLoop 仍在后台跑（interrupt 是异步），它最终可能 reject。
  // 提前挂 catch 吃掉，避免 unhandled rejection 警告。
  consumeLoop.catch(() => undefined);

  let result = '';
  try {
    if (timeoutMs > 0) {
      const timer = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          // 优先优雅中断让 SDK 自己清子进程；interrupt 失败也无所谓，reject 抛错兜底
          q.interrupt?.().catch(() => undefined);
          reject(new Error('__summarizer_timeout__'));
        }, timeoutMs);
      });
      result = await Promise.race([consumeLoop, timer]);
    } else {
      result = await consumeLoop;
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  // REVIEW_35 LOW-B3：删除 `if (timedOut) throw` 死代码 — race timer 先赢时 reject 已抛错
  // 经 try → finally → 异常向上传播，从未到达此处；race consumeLoop 先赢时 timedOut 永远 false
  // （setTimeout callback 永不触发）。timedOut 变量可保留作 race tracing/语义注释，但
  // 「if (timedOut) throw」是 dead branch。
  const cleaned = result.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

/**
 * K3 hand-off 接力简报生成（plan mcp-bug-and-feature-batch-20260513 Phase 4c）。
 *
 * 与 `summariseViaLlm` 字面镜像但 prompt + model 不同：
 * - 用 sonnet 模型（hand-off 是低频但要求结构化输出准确，haiku 偏弱）
 * - prompt 要求输出「目标 / 已做 / 下一步 / 相关文件」四节结构化
 * - resultMaxLen 拉到 4000（允许更长接力简报，hand-off 不像 30 字 tag-line）
 *
 * **不抽公共 helper 重构 summariseViaLlm**：summariseViaLlm 是热路径（每分钟跑数次扫
 * 所有 active session），复制一份代码的痛苦小于改动它的回归风险。如有第三处 oneshot
 * 用例再考虑抽 helper（YAGNI）。
 *
 * 失败处理：caller (IPC handler) 接到 throw 后透传 → renderer modal inline error 让用户
 * 重试或手动编辑兜底 prompt。本函数内只做 timeout race + result 收集，不做 fallback。
 */
export async function summariseSessionForHandOff(
  cwd: string,
  events: AgentEvent[],
): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity) return null;

  const sdk = await loadSdk();
  const runtime = getSdkRuntimeOptions();
  const claudeBinary = getPathToClaudeCodeExecutable();
  const prompt = `下面是某个 Claude Code 会话最近的活动记录。**所有事件都是 Claude（AI 助手）一侧的行为**：
- [Claude 说] = Claude 自己说的话
- [Claude 调用工具] = Claude 在调用工具
- [Claude 主动询问用户] = Claude 用 AskUserQuestion 在向用户提问
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

  const q = sdk.query({
    prompt,
    options: {
      cwd: cwd || process.cwd(),
      // K3 用 sonnet：hand-off 是低频操作（用户主动点按钮）+ 结构化输出对模型理解力
      // 要求高（4 节模板）。优先级与 summariseViaLlm haiku 同模式（plan
      // model-wiring-and-handoff-20260514 Step 4.4）：
      //   1. settings.handOffModel（UI 暴露的字符串字段，'' 表示沿用下面 env / alias 链）
      //   2. ANTHROPIC_DEFAULT_SONNET_MODEL（settings.json 显式配的 sonnet id）
      //   3. ANTHROPIC_MODEL（用户主模型）
      //   4. 'sonnet' alias 兜底
      model:
        settingsStore.get('handOffModel') ||
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
        process.env.ANTHROPIC_MODEL ||
        'sonnet',
      permissionMode: 'plan',
      systemPrompt:
        '你是一个会话接力简报生成助手。基于活动记录生成结构化的「目标 / 已做 / 下一步 / 相关文件」四节简报，' +
        '让接力的下一个 session 能直接续上工作。不要调用工具，不要 Markdown code block 包裹，' +
        '严格按四节模板输出。',
      settingSources: [],
      executable: runtime.executable,
      env: runtime.env,
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
    },
  });

  // K3 单独的超时（不复用 summaryTimeoutMs—— hand-off 用 sonnet 慢，需要更长 budget）。
  // 60s 上限：sonnet + 200 events 通常 10-30s，60s 给 outliers 留余量。
  const timeoutMs = 60_000;
  let timeoutHandle: NodeJS.Timeout | null = null;
  // REVIEW_35 LOW-B3：删 `let timedOut + if (timedOut) throw` 死代码（同 summariseViaLlm）。
  const consumeLoop = (async () => {
    let result = '';
    for await (const msg of q) {
      const m = msg as {
        type: string;
        message?: { content?: { type: string; text?: string }[] };
      };
      if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text) result += block.text;
        }
      }
      if (m.type === 'result') break;
    }
    return result;
  })();
  consumeLoop.catch(() => undefined);

  let result = '';
  try {
    const timer = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        q.interrupt?.().catch(() => undefined);
        reject(new Error('__handoff_summary_timeout__'));
      }, timeoutMs);
    });
    result = await Promise.race([consumeLoop, timer]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  // REVIEW_35 LOW-B3 镜像：同 summariseViaLlm 删 `if (timedOut) throw` 死代码。
  // K3 接力简报允许较长（4000 字 ≈ 1500 token，足够 4 节展开）；
  // 不去多余空白（保留 \n 换行让 textarea preview 直接渲染分段）。
  const cleaned = result.trim();
  return cleaned ? cleaned.slice(0, 4000) : null;
}
