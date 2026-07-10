import type { AgentEvent } from '@shared/types';

/**
 * 把 events 转成给 LLM 看的「最近活动」文本。`events` 入参按 (ts DESC, id DESC)（listForSession
 * 的语义），先按时间升序排回去（按发生顺序读 LLM 才能正确理解前后逻辑），
 * 然后取**最新** 30 行 —— 注意是末尾 30 不是前 30，否则丢掉的是最新 10 条而不是最旧 10 条
 * （历史 bug：原来 `for (...) if (lines.length >= 30) break` 在升序遍历里 break 早，
 * 导致 LLM 看到的总是会话开头那段旧上下文，越往后看到的越旧）。
 *
 * **REVIEW_83 LOW (reviewer-codex 单方 + lead node repro)**: 排序必须带 `id` tie-breaker。
 * `listForSession`（event-repo.ts:112）返回 `ORDER BY ts DESC, id DESC` —— 同毫秒内 id 更大
 * （更新）的 row 排在前面。formatter 旧版仅 `sort((a,b) => a.ts - b.ts)`，JS sort 稳定 →
 * 同 ts 保留输入顺序（id DESC = 新→旧）→ 同毫秒事件在 prompt 里**逆序**（违背本函数
 * 「按发生顺序读」契约，SDK 连续 emit 同毫秒是现实路径，handoff 简报会读到局部反序步骤）。
 * 修法：tie-breaker `(a.ts - b.ts) || (idOf(a) - idOf(b))` 还原同毫秒 chronological（id 升序 =
 * 旧→新）。`events.id` 是 INTEGER AUTOINCREMENT 单调（v001），listForSession 返回类型
 * `AgentEvent & { id: number }` 带此列；入参放宽到 optional id 兼容无 id 的 caller（?? 0 兜底）。
 *
 * `[Claude 说]` 只算 role !== 'user' 且 error !== true 的 message：
 * - 用户输入虽然 emit 成了 message kind 但 role: 'user'，把它写成"Claude 说"会让
 *   总结 LLM 把用户的话误归为 Claude 的动作（典型："push 一下" → 总结成"Claude push"）
 * - error: true 的 ⚠ 警告是基础设施消息（API 错误、待响应队列提示），不是真正
 *   的"Claude 在做什么"
 */
export function formatEventsForPrompt(events: (AgentEvent & { id?: number })[]): string {
  // 升序后取末尾 30：events 已经是 (ts DESC, id DESC)，先排正（ts 升序 + id tie-breaker 还原
  // 同毫秒 chronological），再 slice(-30) 拿最新一段。
  const ordered = [...events]
    .sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0))
    .slice(-30);
  const lines: string[] = [];
  for (const e of ordered) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === 'message') {
      // 过滤用户输入和错误警告：只把 Claude 自己说的话作为"Claude 说"
      if (p.role === 'user' || p.error === true) continue;
      const text = typeof p.text === 'string' ? p.text.replace(/\s+/g, ' ').trim() : '';
      if (text) lines.push(`[Claude 说] ${truncate(text, 240)}`);
    } else if (e.kind === 'tool-use-start') {
      const tool = (p.toolName as string) || 'tool';
      const detail = summariseToolInput(tool, p.toolInput);
      lines.push(detail ? `[Claude 调用工具] ${tool} · ${detail}` : `[Claude 调用工具] ${tool}`);
    } else if (e.kind === 'file-changed') {
      const path = (p.filePath as string) || '';
      if (path) lines.push(`[Claude 改动文件] ${path}`);
    } else if (e.kind === 'waiting-for-user') {
      const type = (p.type as string) || '';
      if (type === 'ask-user-question') {
        const qs = Array.isArray(p.questions) ? (p.questions as { question?: string }[]) : [];
        const qText = qs
          .map((q) => q.question)
          .filter(Boolean)
          .join(' / ');
        lines.push(`[Claude 主动询问用户] ${truncate(qText || '(无文本)', 240)}`);
      } else if (type === 'exit-plan-mode') {
        // ExitPlanMode 不在 prompt 里展开整段 plan（plan 通常很长会撑爆 token），
        // 取首行作为 hint，让 LLM 知道当前 Claude 在等用户批准计划。
        const plan = typeof p.plan === 'string' ? p.plan : '';
        const firstLine = plan.split('\n').find((l) => l.trim()) ?? '';
        lines.push(`[Claude 提议执行计划] ${truncate(firstLine || '(空 plan)', 200)}`);
      } else if (type === 'permission-request') {
        const tool = (p.toolName as string) || '';
        lines.push(`[Claude 请求工具权限] ${tool}`);
      } else {
        const msg = typeof p.message === 'string' ? p.message : '';
        lines.push(`[Claude 等待用户输入] ${truncate(msg, 200)}`);
      }
    }
  }
  return lines.join('\n');
}

function summariseToolInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
      return typeof o.file_path === 'string' ? truncate(o.file_path, 120) : null;
    case 'Bash':
      return typeof o.command === 'string' ? truncate(o.command, 200) : null;
    case 'Grep':
    case 'Glob':
      return typeof o.pattern === 'string' ? truncate(o.pattern, 120) : null;
    case 'Task':
    case 'Agent': {
      const collabTool = typeof o.collab_tool === 'string' ? o.collab_tool : '';
      const agent =
        typeof o.subagent_type === 'string'
          ? o.subagent_type
          : typeof o.task_name === 'string'
            ? o.task_name
            : typeof o.agent_type === 'string'
              ? o.agent_type
              : '';
      const targetValue =
        typeof o.target === 'string' ? o.target : typeof o.id === 'string' ? o.id : '';
      const target = targetValue ? `→ ${targetValue}` : '';
      const model = typeof o.model === 'string' ? o.model : '';
      const effort =
        typeof o.reasoning_effort === 'string'
          ? o.reasoning_effort
          : typeof o.model_reasoning_effort === 'string'
            ? o.model_reasoning_effort
            : '';
      const timeout =
        typeof o.timeout_ms === 'number' && Number.isFinite(o.timeout_ms)
          ? `超时 ${formatDurationMs(o.timeout_ms)}`
          : '';
      const forkTurns = typeof o.fork_turns === 'string' ? o.fork_turns : '';
      const forkContext = typeof o.fork_context === 'boolean' ? o.fork_context : null;
      const receiverTargetCount = Array.isArray(o.receiver_thread_ids)
        ? o.receiver_thread_ids.filter((value) => typeof value === 'string').length
        : 0;
      const rawTargetCount = Array.isArray(o.targets)
        ? o.targets.filter((value) => typeof value === 'string').length
        : 0;
      const targetCount = receiverTargetCount || rawTargetCount;
      const detail = [
        collabTool,
        agent,
        target,
        model && effort ? `${model}/${effort}` : model || effort,
        forkTurns
          ? `fork_turns=${forkTurns}`
          : forkContext === null
            ? ''
            : forkContext
              ? '继承上下文'
              : '不继承上下文',
        typeof o.service_tier === 'string' ? `service_tier=${o.service_tier}` : '',
        typeof o.path_prefix === 'string' ? `范围 ${o.path_prefix}` : '',
        o.interrupt === true ? '先中断' : '',
        timeout,
        targetCount > 0 ? `${targetCount} 个目标` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return detail ? truncate(detail, 200) : null;
    }
    default:
      return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatDurationMs(milliseconds: number): string {
  return milliseconds >= 1000 && milliseconds % 1000 === 0
    ? `${milliseconds / 1000} 秒`
    : `${milliseconds} 毫秒`;
}

/**
 * LLM 全部失败时的最后兜底：扫 events 拿 kind 计数 + file-changed 路径列表，
 * 拼一句「最近 N 条事件；kind×count；改动 a, b, c」给用户看。零依赖、零 IO，
 * 不会进一步失败。
 */
export function localStatsFallback(events: AgentEvent[]): string {
  const counts: Record<string, number> = {};
  const files = new Set<string>();
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.kind === 'file-changed') {
      const p = e.payload as { filePath?: string };
      if (p?.filePath) files.add(p.filePath);
    }
  }
  const parts: string[] = [`最近 ${events.length} 条事件`];
  const topKinds = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join('，');
  parts.push(topKinds);
  if (files.size > 0) {
    const list = [...files].slice(0, 3).join('，');
    parts.push(`改动 ${list}${files.size > 3 ? `（+${files.size - 3}）` : ''}`);
  }
  return parts.join('；');
}
