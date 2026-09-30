import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseFeishuPreferences } from '@contracts/index';
import { requireServerCoreMcpCaller, type ServerCoreMcpCallContext } from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

const preference = z.object({ adapterId: z.enum(['claude-code', 'codex-cli', 'grok-build']).nullable(),
  provider: z.string().max(512), model: z.string().max(512), thinking: z.string().max(512) }).strict();

export function registerServerCoreFeishuPreferenceTool(server: McpServer, context: ServerCoreMcpCallContext): void {
  if (!context.host.feishuPreferences) return;
  server.registerTool('get_feishu_preferences', {
    description: 'Read the paired owner\'s last Feishu conversation and new-session model selections. Read again before a user-requested new work session, so later Feishu/Desktop edits take effect. Null adapter means no saved choice: ask the owner to choose. Empty model/provider/thinking values follow native defaults. This read-only tool does not create sessions, change settings, or grant permissions; explicit user overrides still win.',
    inputSchema: {},
    outputSchema: { conversation: preference, session: preference, settingsRevision: z.number().int().nonnegative() },
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
