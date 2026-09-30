import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GET_SESSION_OUTPUT_SCHEMA } from '@main/agent-deck-mcp/tools/schemas';
import { requireServerCoreMcpCaller, SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  type ServerCoreMcpCallContext } from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';
import { feishuModelPreferenceSchema } from './mcp-feishu-preferences';

export function registerServerCoreFeishuWorkSessionTool(server: McpServer, context: ServerCoreMcpCallContext): void {
  if (!context.host.feishuWorkSessions) return;
  server.registerTool('list_work_sessions', {
    description: 'List the paired owner\'s current work-session metadata when a Feishu assistant is asked which work sessions exist. Requires a live authenticated assistant identity registered by the Feishu owner channel. Includes active and dormant work sessions across this Core Workspace; excludes assistant chats, internal sessions, closed and archived rows. This is the work directory, while list_sessions retains its separate caller-related collaboration scope. No messages, history, provider turns, session changes or permission changes occur. The result identifies the assistant caller, lists session metadata with Workspace-relative cwd, and supplies hasMore and nullable nextOffset. Continue with the returned nextOffset while hasMore is true, including after an empty page: each call examines at most 2000 raw rows. Pages reflect current state, not a frozen snapshot; do not claim a complete list until nextOffset is null. No timeout or automatic retry is configured; an identical read may safely be retried. If the assistant registration is unavailable, ask the owner to send a fresh private message or use /sessions; never substitute the assistant itself as a work session.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Maximum work sessions to return; default 50. Null is invalid.'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 2_000).optional()
        .describe('Opaque raw-row continuation returned as nextOffset; omit for the first page. Default 0. Null is invalid.'),
    },
    outputSchema: {
      scope: z.literal('open-work-sessions'),
      assistantSessionId: z.string(),
      sessions: z.array(GET_SESSION_OUTPUT_SCHEMA).max(100),
      nextOffset: z.number().int().nonnegative().nullable(),
      hasMore: z.boolean(),
    },
    annotations: SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  }, args => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(context.host.feishuWorkSessions!.list(caller.sessionId, args));
    } catch {
      return serverCoreMcpError(new Error('Work-session directory is unavailable for this assistant'),
        'Ask the owner to send a fresh private message to register this assistant, or use /sessions. Do not treat list_sessions as the complete work directory.');
    }
  });
  if (!context.host.feishuManagement) return;
  const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .describe('Required stable 1-128 character ASCII request identity. Reuse for an identical retry; null is invalid.');
  const title = z.string().min(1).max(512).describe('Required trimmed, non-empty single-line name within 512 UTF-8 bytes. Prefer a short task summary; use the owner\'s explicit name unchanged.');
  server.registerTool('create_work_session', {
    description: [
      'Create one independent work session only when the paired Feishu owner requests one.',
      'Requires a live owner-registered assistant and native write-tool approval. Read get_feishu_preferences first and pass its settingsRevision.',
      'Derive a concise title from the requested task unless the owner supplied a name. initialMessage is the actual task, not an assistant-management or teammate prompt.',
      'Omitted selection fields use the last saved work configuration, never this assistant\'s current model or approval policy. Explicit owner overrides are validated and remembered for future work.',
      'workingDirectory is Workspace-relative and defaults to dot; absolute/traversal paths are rejected. Adapter-owned mode/sandbox rules, native approval, Workspace boundaries and shared spawn limits remain enforced.',
      'The new work has independent history. Core registers its real identity before provider output; within subscription capacity Feishu connects replies and selects the committed work unless a newer owner selection intervened. If capacity is full, Feishu explains that the work was created but not connected or selected.',
      'Assistant history and identity are retained. The first task can execute under the target\'s existing native controls.',
      'Returns canonical sessionId, title, effective saved preference, settingsRevision and Core revision. Same requestId and inputs replay the committed result without creating another provider.',
      'No extra timeout or automatic retry is configured. A conflict, startup failure or uncertain cleanup requires list_work_sessions and get_feishu_preferences reconciliation; never create a new requestId to hide an uncertain target.',
    ].join(' '),
    inputSchema: {
      requestId, title,
      initialMessage: z.string().min(1).max(65_536).describe('Required non-blank first task within 65,536 UTF-8 bytes; null is invalid.'),
      expectedSettingsRevision: z.number().int().nonnegative().describe('Required settingsRevision from get_feishu_preferences; null is invalid.'),
      workingDirectory: z.string().max(4096).optional().describe('Optional Workspace-relative directory, default dot. Null, absolute paths and parent traversal are invalid.'),
      selection: feishuModelPreferenceSchema.partial().optional().describe('Optional explicitly owner-chosen overrides; omit to use the saved work selection. Null is invalid; runtime null fields follow target creation defaults.'),
    },
    outputSchema: { sessionId: z.string(), title: z.string(), preference: feishuModelPreferenceSchema,
      settingsRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async args => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.feishuManagement!.create(caller.sessionId, args));
    } catch (error) {
      return serverCoreMcpError(error, 'Read list_work_sessions and get_feishu_preferences before retrying. Keep the same requestId for the same request; do not create another target when startup or rollback is uncertain.');
    }
  });
  server.registerTool('rename_work_session', {
    description: [
      'Rename one unambiguous open work session when the paired owner asks; native write-tool approval and a live registered Feishu assistant are required.',
      'Resolve the target and its current title with list_work_sessions/get_session. Assistant, internal, closed or archived targets are rejected.',
      'Only the Core session name changes; ID, model, sandbox, history, running task and reply selection remain intact. Feishu and Desktop read the same persisted name.',
      'Pass the last read expectedTitle to protect newer manual names. Do not automatically rename an already named work session or overwrite the owner\'s explicit name.',
      'Same requestId, sessionId and desired title return the recorded result even if expectedTitle was reread. A different desired name requires a new requestId and a fresh title.',
      'Returns sessionId, title and Core revision. No additional timeout or automatic retry is configured. On a title conflict, reread and ask before replacing a newer owner name.',
    ].join(' '),
    inputSchema: { requestId, title,
      sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/).describe('Required canonical work-session ID discovered through list_work_sessions; null is invalid.'),
      expectedTitle: z.string().max(512).nullable().describe('Required exact last-read title; null only when the directory returned a null title. Maximum 512 UTF-8 bytes.'),
    },
    outputSchema: { sessionId: z.string(), title: z.string(), revision: z.number().int().nonnegative() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, args => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(context.host.feishuManagement!.rename(caller.sessionId, args));
    } catch (error) {
      return serverCoreMcpError(error, 'Read list_work_sessions/get_session to confirm the target and its latest title. Preserve a newer manual name and ask before replacing it.');
    }
  });
}
