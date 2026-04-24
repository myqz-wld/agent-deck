import type { AgentEvent } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';

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
      return detail ? `🔧 ${tool} · ${detail}` : `🔧 ${tool}`;
    }
    case 'tool-use-end':
      return `${(p.toolName as string) ?? '工具'} 完成`;
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
