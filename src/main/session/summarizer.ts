import type { AgentEvent, SummaryRecord } from '@shared/types';
import { summaryRepo } from '@main/store/summary-repo';
import { eventRepo } from '@main/store/event-repo';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { settingsStore } from '@main/store/settings-store';
import { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';

// 复用 sdk-bridge 里的 dynamic-import 套路：避开 Vite 把 import() 转成 require()，
// 因为 @anthropic-ai/claude-agent-sdk 是 ESM-only 包。
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(
  s: string,
) => Promise<T>;
let sdkPromise: Promise<SdkModule> | null = null;
async function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) sdkPromise = dynamicImport<SdkModule>('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

/**
 * Summarizer 调度：定时扫描所有活跃会话，为达到「时间阈值」或「事件数阈值」
 * 的会话生成一段「会话目前在做什么」的意义层面描述。
 *
 * 优先级：LLM 一句话 → 最近一条 assistant 文字 → 事件统计兜底。
 */
export class Summarizer {
  private timer: NodeJS.Timeout | null = null;
  private lastSummarizedAt = new Map<string, number>();
  private inFlight = new Set<string>();

  start(): void {
    if (this.timer) return;
    const interval = settingsStore.get('summaryIntervalMs');
    this.timer = setInterval(() => void this.scanAll(), Math.max(30_000, Math.floor(interval / 2)));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scanAll(): Promise<void> {
    const sessions = sessionRepo.listActiveAndDormant(50);
    const intervalMs = settingsStore.get('summaryIntervalMs');
    const eventCount = settingsStore.get('summaryEventCount');
    // 全局并发上限：每次总结都会拉一个 cli.js oneshot 子进程跑 LLM，
    // 同时拉起 10+ 子进程会打爆 CPU/网络/API 限流。超出的会话交给下次扫描；
    // sessions 按 last_event_at 倒序，最近活跃的优先得到总结。
    const maxConcurrent = Math.max(1, settingsStore.get('summaryMaxConcurrent'));
    const now = Date.now();
    for (const s of sessions) {
      // 全局并发上限：到顶就退出本轮扫描，下次扫描重新评估。
      if (this.inFlight.size >= maxConcurrent) break;
      if (this.inFlight.has(s.id)) continue;
      const lastTs = this.lastSummarizedAt.get(s.id) ?? s.startedAt;
      const eventsSince = eventRepo.countForSession(s.id, lastTs);
      // 没新事件就跳过：静默会话不需要反复跑 LLM 拿一模一样的总结。
      // 这条比时间/数量阈值优先级更高。
      if (eventsSince === 0) continue;
      const shouldByTime = now - lastTs >= intervalMs;
      const shouldByCount = eventsSince >= eventCount;
      if (!shouldByTime && !shouldByCount) continue;

      // 不阻塞循环：每个会话独立 await，避免一个慢的 LLM 总结拖慢其余会话
      this.inFlight.add(s.id);
      void this.summarize(s.id)
        .then((content) => {
          if (!content) return;
          const rec = summaryRepo.insert({
            sessionId: s.id,
            content,
            trigger: shouldByCount ? 'event-count' : 'time',
            ts: Date.now(),
          });
          eventBus.emit('summary-added', rec);
          this.lastSummarizedAt.set(s.id, Date.now());
        })
        .catch((err) => console.warn(`[summarizer] session ${s.id} failed:`, err))
        .finally(() => this.inFlight.delete(s.id));
    }
  }

  /** 手动触发某会话的总结 */
  async summarizeNow(sessionId: string): Promise<SummaryRecord | null> {
    const summary = await this.summarize(sessionId);
    if (!summary) return null;
    const rec = summaryRepo.insert({
      sessionId,
      content: summary,
      trigger: 'manual',
      ts: Date.now(),
    });
    eventBus.emit('summary-added', rec);
    this.lastSummarizedAt.set(sessionId, Date.now());
    return rec;
  }

  private async summarize(sessionId: string): Promise<string | null> {
    const session = sessionRepo.get(sessionId);
    if (!session) return null;
    const events = eventRepo.listForSession(sessionId, 40);
    if (events.length === 0) return null;

    // 1) 优先：让本地 SDK（复用 ~/.claude OAuth）跑一次 oneshot，让 Claude
    //    自己看历史并写一句话「在做什么」
    try {
      const llm = await summariseViaLlm(session.cwd, events);
      if (llm) return llm;
    } catch (err) {
      console.warn(`[summarizer] LLM failed for ${sessionId}, fallback to last-message`, err);
    }

    // 2) 退化：取最近一条 assistant 文字（最少能说明 Claude 当下在说什么）
    const lastMsg = events.find((e) => e.kind === 'message');
    if (lastMsg) {
      const text = (lastMsg.payload as { text?: string })?.text ?? '';
      if (text) return text.replace(/\s+/g, ' ').trim().slice(0, 100);
    }

    // 3) 再退化：事件 kind 统计
    return localStatsFallback(events);
  }
}

// ────────────────────────────────────────────────────────── helpers

/**
 * 把 events 转成给 LLM 看的「最近活动」文本。所有事件都是 Claude 一侧的动作
 * （用户输入暂未 emit 成 event），因此前缀统一用「Claude …」描述，避免 LLM
 * 把"Claude 调用 AskUserQuestion 询问用户"误总结成"用户询问"。
 */
function formatEventsForPrompt(events: AgentEvent[]): string {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const lines: string[] = [];
  for (const e of ordered) {
    if (lines.length >= 30) break;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === 'message') {
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
    default:
      return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 用本地 OAuth + Claude Code SDK 跑一次 oneshot 总结。关键约束：
 * - settingSources: []   不读 ~/.claude/settings.json，避免 hook 回环到自己
 * - permissionMode: 'plan'  禁止真实工具调用，只让模型输出文字
 * - 一旦收到 result 就立刻 break，让 cli.js 子进程尽快退出
 */
async function summariseViaLlm(cwd: string, events: AgentEvent[]): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity) return null;

  const sdk = await loadSdk();
  const runtime = getSdkRuntimeOptions();
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
      // 模型优先级：settings.json 里配的 ANTHROPIC_DEFAULT_HAIKU_MODEL（具体 id）→
      // ANTHROPIC_MODEL（用户主模型，没配 haiku 但配了主模型时退而求其次）→
      // 'haiku' alias（让什么都没配的环境也能跑，由 SDK / CLI 自己解析）。
      // applyClaudeSettingsEnv 在 bootstrap 时已把 settings.json 的 env 注入 process.env。
      model:
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
    },
  });

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
  const cleaned = result.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

function localStatsFallback(events: AgentEvent[]): string {
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

export const summarizer = new Summarizer();
