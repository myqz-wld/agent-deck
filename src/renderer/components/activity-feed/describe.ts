import type { AgentEvent } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import { toolIcon } from './tool-icons';

/** SimpleRow 单行灰文字摘要：按事件 kind / waiting-for-user 子类型分发到一句中文描述。 */
export function describe(e: AgentEvent): string {
  const p = payloadObject(e.payload);
  switch (e.kind) {
    case 'session-start': {
      const cwd = textValue(p.cwd);
      return cwd ? `会话开始 · ${cwd}` : '会话开始';
    }
    case 'tool-use-start': {
      const tool = textValue(p.toolName) || '工具';
      if (tool === 'ExitPlanMode') return '📋 收到一个执行计划';
      const detail = describeToolInput(tool, p.toolInput);
      return detail ? `${toolIcon(tool)} ${tool} · ${detail}` : `${toolIcon(tool)} ${tool}`;
    }
    case 'tool-use-end': {
      const tool = textValue(p.toolName) || '工具';
      return `${toolIcon(tool)} ${tool} 完成`;
    }
    case 'file-changed': {
      const filePath = textValue(p.filePath);
      return filePath ? `📝 ${filePath}` : '📝 文件改动';
    }
    case 'waiting-for-user': {
      const type = textValue(p.type);
      if (type === 'permission-request') {
        const tool = textValue(p.toolName) || '工具';
        const detail = describeToolInput(tool, p.toolInput);
        return detail ? `⚠️ 等待你授权 ${tool} · ${detail}` : `⚠️ 等待你授权 ${tool}`;
      }
      if (type === 'ask-user-question') return '❓ 收到一个问题';
      if (type === 'exit-plan-mode') return '📋 收到一个执行计划';
      if (type === 'codex-terminal-permission-request') {
        const tool = textValue(p.toolName) || '工具';
        return `⚠️ Codex 等待终端授权 ${tool}`;
      }
      if (type === 'permission-cancelled') return '⚪ 权限请求已取消';
      if (type === 'ask-question-cancelled') return '⚪ 提问已取消';
      if (type === 'exit-plan-cancelled') return '⚪ 计划批准请求已取消';
      const message = textValue(p.message);
      return `⚠️ 等待你的输入${message ? ` · ${message}` : ''}`;
    }
    case 'finished':
      return '✅ 一轮完成';
    case 'session-end': {
      const reason = textValue(p.reason);
      return `⏹ 会话结束${reason ? ` · ${translateSessionEndReason(reason)}` : ''}`;
    }
    // CHANGELOG_165: M3 Agent Teams 事件家族 SimpleRow 渲染(原走 default 只显 e.kind 字符串)。
    // payload schema 见 CHANGELOG_40 §共享类型 TeamTaskPayload / TeamTeammateIdlePayload。
    // handler ingest 时仅含 schema 子集({teamName, taskId, description}+task_create 的 assignee);
    // 兼容写时 teammateName / reason 缺失时 graceful degrade。
    case 'team-task-created': {
      const desc = textValue(p.description) || textValue(p.taskId);
      const teammate = textValue(p.teammateName);
      const team = textValue(p.teamName);
      return `📌 新任务${desc ? ` · ${desc}` : ''}${teammate ? ` (${teammate})` : ''}${team ? ` @ ${team}` : ''}`;
    }
    case 'team-task-completed': {
      const desc = textValue(p.description) || textValue(p.taskId);
      const teammate = textValue(p.teammateName);
      const team = textValue(p.teamName);
      return `✓ 任务完成${desc ? ` · ${desc}` : ''}${teammate ? ` (${teammate})` : ''}${team ? ` @ ${team}` : ''}`;
    }
    case 'team-teammate-idle': {
      const teammate = textValue(p.teammateName);
      const reason = textValue(p.reason);
      return `💤 队友空闲${teammate ? ` · ${teammate}` : ''}${reason ? ` (${reason})` : ''}`;
    }
    default:
      return e.kind;
  }
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** session-end reason 英文枚举 → 中文(active/dormant/closed 等 SDK 内部枚举值统一翻译)。
 *  exported 让 TeamDetail/EventsSection 复用同一份翻译,避免双处维护漂移。 */
export function translateSessionEndReason(reason: string): string {
  switch (reason) {
    case 'completed':
      return '正常结束';
    case 'aborted':
      return '已中止';
    case 'error':
      return '出错';
    case 'max_turns':
      return '达到对话上限';
    case 'stop':
      return '已停止';
    default:
      return reason;
  }
}

/**
 * 工具入参的单行摘要：用在 ToolStartRow 头部 + SimpleRow fallback。
 * 各工具取最具识别度的字段（Edit/Write/Read/MultiEdit 取 file_path、Bash 取 command 等）。
 * 兜底：mcp 图片工具（mcp__<server>__Image*）也走 file_path 摘要。
 */
export function describeToolInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
      return typeof o.file_path === 'string' ? o.file_path : null;
    case 'Bash': {
      const cmd = typeof o.command === 'string' ? o.command.replace(/\s+/g, ' ').trim() : '';
      return cmd ? cmd.slice(0, 80) + (cmd.length > 80 ? '…' : '') : null;
    }
    case 'Grep':
    case 'Glob':
      return typeof o.pattern === 'string' ? o.pattern : null;
    case 'TodoWrite': {
      // CHANGELOG_95: 与 SessionCard summariseToolInput TodoWrite case 同源逻辑（不抽公共 helper：
      // SessionCard 用作 SessionList 单行 live activity，本处用作 ActivityFeed 详情 + SimpleRow，
      // 两处 case 形态接近但 SessionCard 还在 LOC 拆分边界附近，先各自维护避免误抽 helper）。
      // todos schema：{ content, status, activeForm }[]，status: 'pending' | 'in_progress' | 'completed'
      // CHANGELOG_95 review fix LOW-1（reviewer-codex 实测 node -e 复现 TypeError）：
      // 元素为 null/非对象时 t.status 抛错，加 `t && typeof t === 'object'` 守门
      const rawTodos = Array.isArray(o.todos) ? (o.todos as unknown[]) : [];
      const todos = rawTodos.filter(
        (t): t is { status?: string; activeForm?: string } => t !== null && typeof t === 'object',
      );
      if (todos.length === 0) return null;
      const done = todos.filter((t) => t.status === 'completed').length;
      const inProgress = todos.find((t) => t.status === 'in_progress');
      const inProgressLabel =
        inProgress && typeof inProgress.activeForm === 'string'
          ? ` · ${inProgress.activeForm.slice(0, 40)}${inProgress.activeForm.length > 40 ? '…' : ''}`
          : '';
      return `已完成 ${done}/${todos.length}${inProgressLabel}`;
    }
    case 'WebSearch': {
      // CHANGELOG_95: 显示 query 摘要让用户知道在搜什么
      const query = typeof o.query === 'string' ? o.query.replace(/\s+/g, ' ').trim() : '';
      if (!query) return null;
      return `"${query.slice(0, 50)}${query.length > 50 ? '…' : ''}"`;
    }
    case 'WebFetch': {
      // CHANGELOG_95: 显示 url 摘要
      const url = typeof o.url === 'string' ? o.url : '';
      if (!url) return null;
      return url.slice(0, 60) + (url.length > 60 ? '…' : '');
    }
    case 'Skill': {
      // Skill input shape：{ skill: "<plugin:name>" | "<name>", args?: string }
      // 实证扫 26 条 jsonl tool_use：skill 全 string、args 14 条 string + 12 条 absent，无 null/object。
      const skill = typeof o.skill === 'string' ? o.skill : '';
      const args = typeof o.args === 'string' ? o.args.replace(/\s+/g, ' ').trim() : '';
      if (!skill) return null;
      if (args) {
        const argsShort = args.length > 60 ? args.slice(0, 60) + '…' : args;
        return `${skill} · ${argsShort}`;
      }
      return skill;
    }
    case 'Task':
    case 'Agent': {
      // Claude Agent SDK 的 Task 工具：spawn 一个 subagent 干活。
      // 'Agent' 是新版 SDK 的别名（input shape 完全一致：{subagent_type, prompt, description}），
      // 实证 jsonl tool_use 名字混着出现，统一处理。
      // toolInput.subagent_type 是 subagent 名（如 'agent-deck:reviewer-claude' / 'general-purpose'），
      // toolInput.prompt 是给 subagent 的指令文本（可能很长 → 单行摘要截断 60 字够了，
      // 完整 prompt 由 ToolStartRow 「展开 prompt」按钮显示）。
      const sub = typeof o.subagent_type === 'string' ? o.subagent_type : '';
      const prm = typeof o.prompt === 'string' ? o.prompt.replace(/\s+/g, ' ').trim() : '';
      if (!sub && !prm) return null;
      const prmShort = prm.length > 60 ? prm.slice(0, 60) + '…' : prm;
      if (sub && prm) return `${sub} · ${prmShort}`;
      return sub || prmShort;
    }
    case 'TeamCreate': {
      // Agent Teams CLI builtin：{ team_name, description }
      const name = typeof o.team_name === 'string' ? o.team_name : '';
      const desc = typeof o.description === 'string' ? o.description.replace(/\s+/g, ' ').trim() : '';
      if (!name && !desc) return null;
      const descShort = desc.length > 60 ? desc.slice(0, 60) + '…' : desc;
      if (name && desc) return `${name} · ${descShort}`;
      return name || descShort;
    }
    case 'SendMessage': {
      // Agent Teams CLI builtin：{ to | recipient, message, type?, summary? }
      // message 实证可能是 string 也可能是 object（permission_response / shutdown_request 等结构化消息）。
      const to =
        typeof o.recipient === 'string'
          ? o.recipient
          : typeof o.to === 'string'
            ? o.to
            : '';
      // summary 是用户/wrapper 给的简短描述，优先用；否则尝试 message string；否则用 type 名字
      const summary =
        typeof o.summary === 'string' && o.summary.trim()
          ? o.summary.replace(/\s+/g, ' ').trim()
          : typeof o.message === 'string'
            ? o.message.replace(/\s+/g, ' ').trim()
            : o.message && typeof o.message === 'object' && typeof (o.message as { type?: unknown }).type === 'string'
              ? `<${(o.message as { type: string }).type}>`
              : typeof o.type === 'string'
                ? `<${o.type}>`
                : '';
      if (!to && !summary) return null;
      const summaryShort = summary.length > 60 ? summary.slice(0, 60) + '…' : summary;
      if (to && summaryShort) return `→ ${to} · ${summaryShort}`;
      return to ? `→ ${to}` : summaryShort;
    }
    case 'TaskOutput': {
      // Claude Code builtin：读 background bash task 输出。{ task_id, block, timeout }
      const tid = typeof o.task_id === 'string' ? o.task_id : '';
      if (!tid) return null;
      const block = o.block === true ? '阻塞' : o.block === false ? '非阻塞' : '';
      return block ? `${tid} · ${block}` : tid;
    }
    case 'TaskStop': {
      // Claude Code builtin：停 background bash task。{ task_id | shell_id }
      const tid =
        typeof o.task_id === 'string'
          ? o.task_id
          : typeof o.shell_id === 'string'
            ? o.shell_id
            : '';
      return tid || null;
    }
    case 'ExitPlanMode': {
      // 单行简述：取 plan 第一行或第一句话，让 SimpleRow fallback 也能看到大概内容
      const plan = typeof o.plan === 'string' ? o.plan.trim() : '';
      if (!plan) return null;
      const firstLine = plan.split('\n').find((l) => l.trim()) ?? '';
      return firstLine.slice(0, 80) + (firstLine.length > 80 ? '…' : '');
    }
    default: {
      if (isImageTool(toolName) && typeof o.file_path === 'string') {
        return o.file_path;
      }
      return null;
    }
  }
}
