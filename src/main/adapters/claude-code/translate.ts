import type { AgentEvent, ImageSource, ImageToolResult, TeamPermissionCancelled, TeamPermissionRequest } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';

const AGENT_ID = 'claude-code';

/**
 * Claude Code hook payload 格式（来自 Claude Code 文档 + 实测）：
 *
 * - SessionStart:    { session_id, transcript_path, cwd, source }
 * - PreToolUse:      { session_id, transcript_path, cwd, tool_name, tool_input }
 * - PostToolUse:     { session_id, transcript_path, cwd, tool_name, tool_input, tool_response }
 * - Notification:    { session_id, transcript_path, cwd, message }
 * - Stop:            { session_id, transcript_path, cwd, stop_hook_active }
 * - SessionEnd:      { session_id, transcript_path, cwd, reason }
 *
 * 我们把它们翻译为统一的 AgentEvent。
 */

interface BaseHookPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
}

export function translateSessionStart(p: BaseHookPayload & { source?: string }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'session-start',
    payload: { cwd: p.cwd, transcriptPath: p.transcript_path, source: p.source },
    ts: Date.now(),
  };
}

// ───────────────────────────────────────────────────────── Agent Teams hooks (M3)

/**
 * Claude Code v2.1.32+ Agent Teams 实验特性 hook payload。**字段名按官方文档常见命名 +
 * 实测推断**——schema 仍在演进，所有字段宽容提取，缺失兜底到 undefined，原始 payload
 * 全量塞进 raw 让 UI 能 fallback。
 */
interface TeamHookPayload {
  session_id: string;
  cwd?: string;
  team_name?: string;
  teammate_name?: string;
  agent_name?: string;
  task?: {
    id?: string;
    description?: string;
    title?: string;
    content?: string;
    assignee?: string;
    depends_on?: string[];
    dependencies?: string[];
    status?: string;
    state?: string;
  };
  /** TeammateIdle 专属 */
  last_task?: string;
  reason?: string;
  [key: string]: unknown;
}

/** 从 task 对象里挑 description / title / content 任一非空。 */
function pickDescription(task: TeamHookPayload['task']): string | undefined {
  if (!task) return undefined;
  if (typeof task.description === 'string' && task.description) return task.description;
  if (typeof task.title === 'string' && task.title) return task.title;
  if (typeof task.content === 'string' && task.content) return task.content;
  return undefined;
}

/** 从 task 对象里挑 depends_on / dependencies 任一数组。 */
function pickDependsOn(task: TeamHookPayload['task']): string[] | undefined {
  if (!task) return undefined;
  if (Array.isArray(task.depends_on)) return task.depends_on.filter((x) => typeof x === 'string');
  if (Array.isArray(task.dependencies)) return task.dependencies.filter((x) => typeof x === 'string');
  return undefined;
}

export function translateTaskCreated(p: TeamHookPayload): AgentEvent {
  const task = p.task ?? {};
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'team-task-created',
    payload: {
      cwd: p.cwd,
      teamName: typeof p.team_name === 'string' ? p.team_name : undefined,
      teammateName:
        typeof p.teammate_name === 'string'
          ? p.teammate_name
          : typeof p.agent_name === 'string'
            ? p.agent_name
            : undefined,
      taskId: typeof task.id === 'string' ? task.id : undefined,
      description: pickDescription(task),
      assignee: typeof task.assignee === 'string' ? task.assignee : undefined,
      dependsOn: pickDependsOn(task),
      status: typeof task.status === 'string' ? task.status : typeof task.state === 'string' ? task.state : undefined,
      raw: p as Record<string, unknown>,
    },
    ts: Date.now(),
  };
}

export function translateTaskCompleted(p: TeamHookPayload): AgentEvent {
  const task = p.task ?? {};
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'team-task-completed',
    payload: {
      cwd: p.cwd,
      teamName: typeof p.team_name === 'string' ? p.team_name : undefined,
      teammateName:
        typeof p.teammate_name === 'string'
          ? p.teammate_name
          : typeof p.agent_name === 'string'
            ? p.agent_name
            : undefined,
      taskId: typeof task.id === 'string' ? task.id : undefined,
      description: pickDescription(task),
      assignee: typeof task.assignee === 'string' ? task.assignee : undefined,
      dependsOn: pickDependsOn(task),
      status: typeof task.status === 'string' ? task.status : typeof task.state === 'string' ? task.state : undefined,
      raw: p as Record<string, unknown>,
    },
    ts: Date.now(),
  };
}

export function translateTeammateIdle(p: TeamHookPayload): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'team-teammate-idle',
    payload: {
      cwd: p.cwd,
      teamName: typeof p.team_name === 'string' ? p.team_name : undefined,
      teammateName:
        typeof p.teammate_name === 'string'
          ? p.teammate_name
          : typeof p.agent_name === 'string'
            ? p.agent_name
            : undefined,
      lastTask: typeof p.last_task === 'string' ? p.last_task : undefined,
      reason: typeof p.reason === 'string' ? p.reason : undefined,
      raw: p as Record<string, unknown>,
    },
    ts: Date.now(),
  };
}

/**
 * Inbox Watcher (CHANGELOG_45)：把 teammate 提的 permission_request 包成应用统一的
 * AgentEvent，复用 PendingTab 的 by-session pending 渲染机制。
 *
 * sessionId 由调用方传入：典型是 lead session id，让 UI 看起来「这条审批属于 lead 会话的
 * 待办」（事实上是 lead 帮 teammate 转发审批，语义上挂在 lead 会话最直观）。
 *
 * payload 直接是 TeamPermissionRequest（type='team-permission-request'），UI 端
 * pending-rows 模块按 type 分发到 TeamPermissionRow。
 */
export function translateTeamPermissionRequest(
  req: TeamPermissionRequest,
  leadSessionId: string,
): AgentEvent {
  return {
    sessionId: leadSessionId,
    agentId: AGENT_ID,
    kind: 'waiting-for-user',
    payload: req,
    ts: Date.parse(req.timestamp) || Date.now(),
    source: 'sdk', // 来自 lead SDK 会话的内部 teammate；不是 cli hook
  };
}

/**
 * Inbox Watcher：teammate 自己 abort permission（idle_notification 触发，详见
 * TeamPermissionCancelled 注释）→ AgentEvent waiting-for-user kind + payload type
 * 'team-permission-cancelled'，与 PermissionCancelled / AskQuestionCancelled /
 * ExitPlanCancelled 同模式让 store 从 pending 列表移除 + activity-feed 标灰显示。
 */
export function translateTeamPermissionCancelled(
  cancel: TeamPermissionCancelled,
  leadSessionId: string,
): AgentEvent {
  return {
    sessionId: leadSessionId,
    agentId: AGENT_ID,
    kind: 'waiting-for-user',
    payload: cancel,
    ts: Date.now(),
    source: 'sdk',
  };
}

export function translatePreToolUse(
  p: BaseHookPayload & { tool_name?: string; tool_input?: unknown },
): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'tool-use-start',
    payload: { cwd: p.cwd, toolName: p.tool_name, toolInput: p.tool_input },
    ts: Date.now(),
  };
}

interface EditToolInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

interface WriteToolInput {
  file_path?: string;
  content?: string;
}

interface MultiEditToolInput {
  file_path?: string;
  edits?: { old_string: string; new_string: string }[];
}

// ───────────────────────────────────────────────────────── Image MCP tools

/**
 * 图片工具的 file-changed payload（不含 sessionId/agentId/ts/kind/cwd）。
 * sdk-bridge 与 hook PostToolUse 共用 imageResultToFileChanges 输出，再各自补包装。
 */
export interface ImageFileChangedPayload {
  filePath: string;
  kind: 'image';
  before: ImageSource | null;
  after: ImageSource | null;
  metadata: Record<string, unknown>;
  toolCallId?: string;
}

/**
 * 解析 MCP 图片工具的 tool_result.content。
 * 兼容三种形态：
 * - string  → 直接 JSON.parse
 * - Block[] → 找第一个 {type:'text', text:string}，对 text JSON.parse
 * - 其他    → 返回 null
 * 解析后的对象必须有 `kind` 字段且以 'image-' 开头才算合法。
 */
export function parseImageToolResult(content: unknown): ImageToolResult | null {
  if (content == null) return null;
  const tryParse = (s: string): ImageToolResult | null => {
    try {
      const v = JSON.parse(s) as ImageToolResult & { kind?: string };
      if (typeof v?.kind === 'string' && v.kind.startsWith('image-')) return v;
    } catch {
      /* swallow */
    }
    return null;
  };
  if (typeof content === 'string') return tryParse(content);
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object') {
        const bb = b as { type?: string; text?: string };
        if (bb.type === 'text' && typeof bb.text === 'string') {
          const r = tryParse(bb.text);
          if (r) return r;
        }
      }
    }
  }
  return null;
}

/**
 * 把一条 ImageToolResult 翻译成 0~N 条 file-changed payload。
 *
 * - image-read  → 0 条（不进 file_changes 表，由活动流的「缩略图 + 描述」卡片覆盖）
 * - image-write → 1 条：before=null, after=path（文生图新文件）；metadata 带 prompt / provider / model
 * - image-edit  → 1 条：before/after 各指向 server 快照路径；metadata 带 prompt / provider / model
 * - image-multi-edit → N 条，filePath 都用 result.file（同一张图，让 SessionDetail 按文件分组聚合）
 *   每条 metadata 带 editIndex / total / prompt / provider / model
 */
export function imageResultToFileChanges(
  result: ImageToolResult,
  toolUseId?: string,
): ImageFileChangedPayload[] {
  switch (result.kind) {
    case 'image-read':
      return [];
    case 'image-write':
      return [
        {
          filePath: result.file,
          kind: 'image',
          before: null,
          after: { kind: 'path', path: result.file },
          metadata: {
            source: 'ImageWrite',
            prompt: result.prompt,
            ...(result.provider ? { provider: result.provider } : {}),
            ...(result.model ? { model: result.model } : {}),
            ...(result.mime ? { mime: result.mime } : {}),
          },
          toolCallId: toolUseId,
        },
      ];
    case 'image-edit':
      return [
        {
          filePath: result.file,
          kind: 'image',
          before: { kind: 'path', path: result.beforeFile },
          after: { kind: 'path', path: result.afterFile },
          metadata: {
            source: 'ImageEdit',
            prompt: result.prompt,
            ...(result.provider ? { provider: result.provider } : {}),
            ...(result.model ? { model: result.model } : {}),
            ...(result.mime ? { mime: result.mime } : {}),
          },
          toolCallId: toolUseId,
        },
      ];
    case 'image-multi-edit':
      return result.edits.map((e, i) => ({
        filePath: result.file,
        kind: 'image' as const,
        before: { kind: 'path' as const, path: e.beforeFile },
        after: { kind: 'path' as const, path: e.afterFile },
        metadata: {
          source: 'ImageMultiEdit',
          prompt: e.prompt,
          editIndex: i,
          total: result.edits.length,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.model ? { model: result.model } : {}),
        },
        toolCallId: toolUseId,
      }));
  }
}

// ──────────────────────────────────────────────────────────────────────

/**
 * PostToolUse 翻译。如果 tool_name 是 Edit/Write/MultiEdit，会同时返回
 * 一个 file-changed 事件（包含 before/after）。
 */
export function translatePostToolUse(
  p: BaseHookPayload & {
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
  },
): AgentEvent[] {
  const ts = Date.now();
  const events: AgentEvent[] = [
    {
      sessionId: p.session_id,
      agentId: AGENT_ID,
      kind: 'tool-use-end',
      payload: {
        cwd: p.cwd,
        toolName: p.tool_name,
        toolInput: p.tool_input,
        toolResponse: p.tool_response,
      },
      ts,
    },
  ];

  if (!p.tool_name) return events;

  if (p.tool_name === 'Edit') {
    const input = p.tool_input as EditToolInput;
    if (input?.file_path) {
      events.push({
        sessionId: p.session_id,
        agentId: AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before: input.old_string ?? null,
          after: input.new_string ?? null,
          metadata: { source: 'Edit' },
        },
        ts,
      });
    }
  } else if (p.tool_name === 'Write') {
    const input = p.tool_input as WriteToolInput;
    if (input?.file_path) {
      events.push({
        sessionId: p.session_id,
        agentId: AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before: null, // Write 不携带 before；UI 渲染时可标记为「新文件」
          after: input.content ?? null,
          metadata: { source: 'Write' },
        },
        ts,
      });
    }
  } else if (p.tool_name === 'MultiEdit') {
    const input = p.tool_input as MultiEditToolInput;
    if (input?.file_path && Array.isArray(input.edits)) {
      // 把多条 edits 合成 before/after：依次拼接每条 edit 的方向
      const before = input.edits.map((e) => e.old_string).join('\n---\n');
      const after = input.edits.map((e) => e.new_string).join('\n---\n');
      events.push({
        sessionId: p.session_id,
        agentId: AGENT_ID,
        kind: 'file-changed',
        payload: {
          cwd: p.cwd,
          filePath: input.file_path,
          kind: 'text',
          before,
          after,
          metadata: { source: 'MultiEdit', editCount: input.edits.length },
        },
        ts,
      });
    }
  } else if (isImageTool(p.tool_name)) {
    // MCP 图片工具（mcp__<server>__Image*）：解析 server 返回的结构化 JSON，
    // 翻译成 0~N 条 file-changed 事件（payload.before/after 是 ImageSource，不带图片二进制）
    const parsed = parseImageToolResult(p.tool_response);
    if (parsed) {
      for (const fc of imageResultToFileChanges(parsed)) {
        events.push({
          sessionId: p.session_id,
          agentId: AGENT_ID,
          kind: 'file-changed',
          payload: {
            cwd: p.cwd,
            ...fc,
          },
          ts,
        });
      }
    }
  }

  return events;
}

export function translateNotification(p: BaseHookPayload & { message?: string }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'waiting-for-user',
    payload: { cwd: p.cwd, message: p.message },
    ts: Date.now(),
  };
}

export function translateStop(p: BaseHookPayload & { stop_hook_active?: boolean }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'finished',
    payload: { cwd: p.cwd, stopHookActive: p.stop_hook_active },
    ts: Date.now(),
  };
}

export function translateSessionEnd(p: BaseHookPayload & { reason?: string }): AgentEvent {
  return {
    sessionId: p.session_id,
    agentId: AGENT_ID,
    kind: 'session-end',
    payload: { cwd: p.cwd, reason: p.reason },
    ts: Date.now(),
  };
}
