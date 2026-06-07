/**
 * LLM oneshot 用 prompt + system prompt 模板（R37 P2-H Step 3.2）。
 *
 * **抽出动机**（reviewer 双对抗 R1 H4 finding）：
 * 4 个 runner（claude summarise / claude handoff / codex summarise / codex handoff）
 * 内联 prompt 字面 4 份，仅 agent 身份（Claude / Agent）+ intro 措辞 + （summarize 比 handoff
 * 多一句「不是用户在问 Claude」的澄清）三处差异。重复维护时改一处忘改另一处会让 4 路输出
 * 漂移（典型：增 marker 类型 / 调措辞）。
 *
 * **agentName 参数化**：claude SDK 用 'Claude'，codex SDK 用 'Agent'（与 codex
 * handoff-runner.ts:67-69 同款约定）；marker label `[Claude 说]` 等保留字面，因为是
 * formatEventsForPrompt 的固定输出 label，模型只需按提示理解 label 含义即可，不需要本地化。
 */
export type AgentName = 'Claude' | 'Agent';

/**
 * 一句话 summarize prompt（≤ 30 字总结，hot-path 周期性扫描调用）。
 *
 * Claude 版与 Agent 版差异：
 * - intro：「Claude Code 会话」 vs 「AI 助手会话」
 * - 主体每处 `Claude` → `Agent`
 * - 「不是用户在问 ${a}」澄清括号两版都保留（与 R37 前现状一致，handoff 才删）
 */
export function buildSummarizePrompt(opts: {
  cwd: string;
  activity: string;
  agentName: AgentName;
}): string {
  const { cwd, activity, agentName: a } = opts;
  const intro = a === 'Claude' ? 'Claude Code 会话' : 'AI 助手会话';
  return `下面是某个 ${intro}最近的活动记录。**所有事件都是 ${a}（AI 助手）一侧的行为**：
- [Claude 说] = ${a} 自己说的话
- [Claude 调用工具] = ${a} 在调用工具
- [Claude 主动询问用户] = ${a} 用 AskUserQuestion 在向用户提问（不是用户在问 ${a}）
- [Claude 改动文件] / [Claude 请求工具权限] = 字面意思

请只根据上面的事件，用一句简洁中文（不超过 30 字）总结 ${a} 当前正在做的核心任务。
若事件不足以判断任务，输出“等待更多活动”。
直接输出这句描述，不要前缀、不要解释、不要 Markdown、不要调用任何工具。
**绝不能把 ${a} 的动作写成"用户 …"** —— 用户的输入不在记录中。

会话目录：${cwd || '(未知)'}
最近活动：
${activity}`;
}

/**
 * 接力简报 handoff prompt（4 节结构化输出，hand-off 用户主动触发的低频但要求高路径）。
 *
 * 与 summarize prompt 差异：
 * - 「主动询问用户」澄清括号去掉（handoff 不强调防 role 混淆）
 * - 主体改 4 节模板（目标 / 已做 / 下一步 / 相关文件），允许 4000 字输出
 *
 * Claude 版与 Agent 版差异同 summarize（intro + a 替换）。
 */
export function buildHandoffPrompt(opts: {
  cwd: string;
  activity: string;
  agentName: AgentName;
}): string {
  const { cwd, activity, agentName: a } = opts;
  const intro = a === 'Claude' ? 'Claude Code 会话' : 'AI 助手会话';
  return `下面是某个 ${intro}最近的活动记录。**所有事件都是 ${a}（AI 助手）一侧的行为**：
- [Claude 说] = ${a} 自己说的话
- [Claude 调用工具] = ${a} 在调用工具
- [Claude 主动询问用户] = ${a} 用 AskUserQuestion 在向用户提问
- [Claude 改动文件] / [Claude 请求工具权限] = 字面意思

请只基于这些事件生成一份「接力简报」，让另一个新 session agent 能接着干活。不要补写事件里没有的步骤、文件或结论。

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
- ...（最多 10 个，只从 [Claude 改动文件] / [Claude 调用工具] Edit/Read/Write 中提；没有就写“无”）

输出后请直接返回，**不要调用任何工具**。`;
}

/**
 * Claude SDK summarize 的 systemPrompt（codex SDK 不接受 systemPrompt — codex 在
 * `~/.codex/config.toml` 顶层配；本常量仅 claude-runner.ts 用）。
 *
 * 与 prompt body 关注点一致：基于事件生成一句中文描述 + 防 role 混淆（"用户 …"）+ 禁工具。
 */
export const CLAUDE_SUMMARIZE_SYSTEM_PROMPT =
  '你是一个会话观察助手。你看到的每一条事件都是 Claude（AI 助手）一侧的行为，' +
  '用户输入不会出现在记录里。基于这些事件用一句简短中文描述 Claude 当前任务。' +
  '事件不足以判断时输出“等待更多活动”。不要把 Claude 的动作写成"用户 …"，不要调用工具，不要展开解释。';

/**
 * Claude SDK handoff 的 systemPrompt（同上仅 claude-runner.ts 用）。
 *
 * 强调 4 节结构化模板 + 不要 Markdown wrapper + 禁工具。
 */
export const CLAUDE_HANDOFF_SYSTEM_PROMPT =
  '你是一个会话接力简报生成助手。基于活动记录生成结构化的「目标 / 已做 / 下一步 / 相关文件」四节简报，' +
  '让接力的下一个 session 能直接续上工作。只使用活动记录里的事实，不要补写不存在的步骤、文件或结论。不要调用工具，不要 Markdown code block 包裹，' +
  '严格按四节模板输出。';
