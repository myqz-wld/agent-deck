import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseFeishuPreferences } from '@contracts/index';
import { ADAPTER_SESSION_MODES, CODEX_APPROVAL_POLICIES, PERMISSION_MODES } from '@shared/types';
import { requireServerCoreMcpCaller, SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS, type ServerCoreMcpCallContext } from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

const preference = z.object({ adapterId: z.enum(['claude-code', 'codex-cli', 'grok-build']).nullable(),
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
    outputSchema: { conversation: preference, session: preference, settingsRevision: z.number().int().nonnegative() },
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
}
