import type { AgentEvent } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import { toolIcon } from './tool-icons';

/** SimpleRow 单行灰文字摘要：按事件 kind / waiting-for-user 子类型分发到一句中文描述。 */
export function describe(e: AgentEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'session-start':
      return `会话开始 · ${(p.cwd as string) ?? ''}`;
    case 'tool-use-start': {
      const tool = (p.toolName as string) ?? '工具';
      if (tool === 'ExitPlanMode') return '📋 Claude 提议了一个执行计划';
      const detail = describeToolInput(tool, p.toolInput);
      return detail ? `${toolIcon(tool)} ${tool} · ${detail}` : `${toolIcon(tool)} ${tool}`;
    }
    case 'tool-use-end': {
      const tool = (p.toolName as string) ?? '工具';
      return `${toolIcon(tool)} ${tool} 完成`;
    }
    case 'file-changed':
      return `📝 ${(p.filePath as string) ?? ''}`;
    case 'waiting-for-user': {
      const type = (p.type as string) ?? '';
      if (type === 'permission-request') return `⚠ 等待你授权 ${(p.toolName as string) ?? ''}`;
      if (type === 'ask-user-question') return '❓ Claude 在询问你';
      if (type === 'exit-plan-mode') return '📋 Claude 提议了一个执行计划';
      if (type === 'permission-cancelled') return '⚪ 权限请求已被 SDK 取消';
      if (type === 'ask-question-cancelled') return '⚪ 提问已被 SDK 取消';
      if (type === 'exit-plan-cancelled') return '⚪ 计划批准请求已被 SDK 取消';
      return `⚠ 等待你的输入${p.message ? ` · ${p.message as string}` : ''}`;
    }
    case 'finished':
      return '✅ 一轮完成';
    case 'session-end':
      return `⏹ 会话结束${p.reason ? ` · ${p.reason as string}` : ''}`;
    default:
      return e.kind;
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
