import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseFeishuPreferences } from '@contracts/index';
import { ADAPTER_SESSION_MODES, CODEX_APPROVAL_POLICIES, PERMISSION_MODES } from '@shared/types';
import { requireServerCoreMcpCaller, SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS, type ServerCoreMcpCallContext } from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

export const feishuModelPreferenceSchema = z.object({ adapterId: z.enum(['claude-code', 'codex-cli', 'grok-build']).nullable(),
  provider: z.string().max(512), model: z.string().max(512), thinking: z.string().max(512),
  permissionMode: z.enum(PERMISSION_MODES).nullable().optional(),
  approvalPolicy: z.enum(CODEX_APPROVAL_POLICIES).nullable().optional(),
  sessionMode: z.enum(ADAPTER_SESSION_MODES).nullable().optional(),
  claudeCodeSandbox: z.enum(['off', 'workspace-write', 'strict']).nullable().optional(),
  codexSandbox: z.enum(['workspace-write', 'read-only', 'danger-full-access']).nullable().optional(),
  grokSandbox: z.string().min(1).max(128).nullable().optional(),
}).strict();

export function registerServerCoreFeishuPreferenceTool(server: McpServer, context: ServerCoreMcpCallContext): void {
  if (!context.host.feishuPreferences) return;
  server.registerTool('get_feishu_preferences', {
    description: 'Read the paired owner\'s last Feishu conversation and new-work-session configurations before a user-requested work creation, so later Feishu/Desktop edits take effect. Requires a live authenticated session caller. Returns both independent selections and a non-negative settingsRevision; null adapter means no saved choice, so ask the owner to choose. Empty model/provider/thinking values follow native defaults. Optional mode and sandbox fields belong only to the selected adapter: Claude permissionMode/claudeCodeSandbox, Codex approvalPolicy/codexSandbox, Grok sessionMode/grokSandbox. Missing or null runtime fields follow that target adapter\'s creation defaults, not this assistant\'s current policy. Explicit owner overrides win; pass only fields admitted by the target creation tool. The Core Workspace ceiling remains enforced. This read-only tool takes no arguments and does not create sessions, change existing sessions or settings, or grant permissions. No timeout or automatic retry is configured; identical reads may be retried safely. On unavailable preferences, ask the owner to check /settings or connected Core settings; do not silently choose another adapter.',
    inputSchema: {},
    outputSchema: { conversation: feishuModelPreferenceSchema, session: feishuModelPreferenceSchema, settingsRevision: z.number().int().nonnegative() },
    annotations: SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  }, () => {
    try {
      requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(parseFeishuPreferences(context.host.feishuPreferences!.read()));
    } catch {
      return serverCoreMcpError(new Error('Feishu model preferences are unavailable'),
        'Ask the owner to check /settings in Feishu or the connected Core settings. Do not substitute another adapter.');
    }
  });
  if (!context.host.feishuManagement) return;
  server.registerTool('update_feishu_preferences', {
    description: [
      'Save a paired owner\'s explicitly requested future assistant-chat or work-session configuration.',
      'Requires a live owner-registered Feishu assistant and native write-tool approval. First read get_feishu_preferences and pass its settingsRevision.',
      'purpose conversation changes future assistant chats; session changes future work sessions. Existing session runtimes are unchanged.',
      'preference is a partial patch: omitted same-adapter fields keep the last choice; a different adapter resets incompatible fields.',
      'Only that adapter\'s mode/sandbox fields are allowed. Empty model/provider/thinking and missing or null runtime fields follow target defaults.',
      'Live Core capabilities and the Workspace ceiling remain authoritative. The call does not start provider work or grant permissions.',
      'Returns both saved selections, settingsRevision and current Core revision. Use a new stable requestId for each intended change and reuse it for an identical retry.',
      'A completed retry returns the original saved result. Conflicts or uncertain results require a fresh read and owner intent before another change; do not retry under a new key automatically.',
      'No additional timeout or automatic retry is configured. Never use this tool to invent or switch the owner\'s model choice.',
    ].join(' '),
    inputSchema: {
      requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).describe('Required stable 1-128 character ASCII mutation identity; null is invalid.'),
      purpose: z.enum(['conversation', 'session']).describe('Required future-default target; null is invalid.'),
      preference: feishuModelPreferenceSchema.partial().describe('Required partial adapter-owned selection; no unknown fields. Omitted properties remain unchanged within the same adapter.'),
      expectedSettingsRevision: z.number().int().nonnegative().describe('Required settingsRevision from the last get_feishu_preferences result; null is invalid.'),
    },
    outputSchema: { conversation: feishuModelPreferenceSchema, session: feishuModelPreferenceSchema,
      settingsRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async args => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.feishuManagement!.updatePreferences(caller.sessionId, args));
    } catch (error) {
      return serverCoreMcpError(error, 'Read get_feishu_preferences to reconcile the current selections. Preserve the owner\'s choices; do not repeat an uncertain write under a new requestId.');
    }
  });
}
