/**
 * Agent Deck MCP server stdio transport（B'0 ADR §2 / §4.3 / B'1）。
 *
 * 通过 `agent-deck mcp` 子命令启动一个独立 Node 进程，接管 stdin/stdout 跑
 * StdioServerTransport。外部 MCP client（Cursor / Continue / Claude Desktop / 任何
 * stdio MCP client）配置：
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "agent-deck": {
 *       "command": "agent-deck",
 *       "args": ["mcp"]
 *     }
 *   }
 * }
 * ```
 *
 * 安全约束（ADR §4.3 / §11.7）：stdio 没有 caller-id 反查链路，client 只能传特殊
 * 值 `__external__` 作为 caller_session_id，仅允许 list_sessions / get_session 等只读 /
 * 观察类 tool；spawn / send / shutdown 默认 deny（防 fork bomb）。
 *
 * 启用条件：`settings.enableAgentDeckMcp === true && settings.mcpStdioEnabled === true`。
 * 任一关 → 子进程启动时打印「未启用」错误后退出。
 */

import { buildAgentDeckTools } from './tools';
import { EXTERNAL_CALLER_SENTINEL } from './types';

/**
 * @internal Only for `__tests__/`. Do NOT import from other production files.
 *
 * **R3 fix-4 (M2 codex Batch C+D MED-1)**：stdio transport 的 callerSessionIdOverride lambda
 * export 给 spoofing-attack-paths.test.ts 真 import 绑 production。
 *
 * **抽出动机**：旧版 test 本地复制 `const stdioOverride = () => EXTERNAL_CALLER_SENTINEL` 不绑
 * production transport-stdio.ts → 将来 transport-stdio.ts 回退成 `callerSessionIdOverride: null`
 * test 仍 pass 不报警 → B-HIGH-1 修法回归被静默 ship。export 后 test 真 import lambda,production
 * 回退会让 test 同步 fail。
 *
 * **行为不变**: 永返 `__external__` sentinel 切断 spoofing 路径（与 buildAgentDeckTools 内部
 * `overridden ?? args.caller_session_id` 短路逻辑配合，让任何 args.caller_session_id 被忽略）。
 *
 * **禁止扩散**: 仅 transport-stdio.ts 内使用 + `__tests__/spoofing-attack-paths.test.ts` 校验
 * 用。其他 production 文件想用 sentinel 直接 `import { EXTERNAL_CALLER_SENTINEL } from './types'`
 * 即可，不要 import 本 lambda（与 D6 export 仅供 __tests__/ 原则对称）。
 */
export const stdioCallerSessionIdOverride = (): string => EXTERNAL_CALLER_SENTINEL;

const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(
  s: string,
) => Promise<T>;

interface McpStdioModule {
  StdioServerTransport: new () => {
    start: () => Promise<void>;
    close: () => Promise<void>;
  };
}

interface McpServerModule {
  McpServer: new (info: { name: string; version: string }) => {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      cb: (args: any, extra?: unknown) => Promise<any>,
    ) => unknown;
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
}

/**
 * stdio 子命令入口：被 `cli.ts` 在子进程内调，接管 stdin/stdout 跑 MCP 协议。
 *
 * Note：本进程 **不是** Agent Deck 主进程（Electron main）—— 是 wrapper 起的独立
 * Node 子进程，没有 SQLite / sessionManager / adapterRegistry / hookServer 本地访问。
 *
 * 因此 stdio transport 的 tool handler 实际工作模式（B'2.a 实现）：
 * - 通过 IPC（Unix socket / shared HTTP 反向调用）转发到主进程
 * - 或主进程也开 HTTP transport 时，stdio 进程内用 HTTP transport 透传（双跳）
 *
 * 当前 B'1 阶段：仅暴露 6 tool 占位 schema 让外部 client 能 list_tools 见到形状；
 * 真正逻辑（IPC / HTTP 反向调用）放 B'2.a 与 B'5 同改。
 */
export async function runAgentDeckMcpStdio(): Promise<void> {
  const [serverMod, stdioMod] = await Promise.all([
    dynamicImport<McpServerModule>('@modelcontextprotocol/sdk/server/mcp.js'),
    dynamicImport<McpStdioModule>('@modelcontextprotocol/sdk/server/stdio.js'),
  ]);

  const mcpServer = new serverMod.McpServer({
    name: 'agent-deck',
    version: '0.1.0',
  });

  // B-HIGH-1 (C) 修法 (b)（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）:
  // stdio transport 没 per-session authn 链路，client 只能传特殊值 `__external__` 当
  // caller_session_id（ADR §4.3 / §11.7 文档约定）。旧版 callerSessionIdOverride: null 让
  // tools/index.ts:108 的 `overridden ?? args.caller_session_id` fallback 到任意 args 字段，
  // client 能填已存在 active sid spoof 写工具（B-HIGH-1 reviewer-claude 反驳轮 mini-test 实证）。
  // 修法: force callerSessionIdOverride 永返 sentinel，让 stdio transport 在源头切断 spoofing
  // 路径（与 helpers.ts denyExternalIfNotAllowed (a) stdio invariant assertion 双层守门 = 修法 (C)）。
  //
  // **R3 fix-4 (M2 codex Batch C+D MED-1)**: 抽 module-level export `stdioCallerSessionIdOverride`
  // 给 spoofing-attack-paths.test.ts 真 import 绑 production（旧版 test 本地复制 const stdioOverride
  // 不绑 production → 将来 transport-stdio.ts 回退成 `callerSessionIdOverride: null` test 仍 pass
  // 不报警 → 漏洞回归被静默 ship）。export 仅供 __tests__ import,严禁其他 production 文件 import。
  const adapted = await buildAgentDeckTools({
    callerSessionIdOverride: stdioCallerSessionIdOverride,
    transport: 'stdio',
  });
  for (const t of adapted) {
    const def = t as unknown as {
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      handler: (args: any, extra: unknown) => Promise<any>;
      annotations?: Record<string, unknown>;
    };
    mcpServer.registerTool(
      def.name,
      {
        description: def.description ?? '',
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      },
      def.handler,
    );
  }

  const transport = new stdioMod.StdioServerTransport();
  // McpServer.connect 会调 transport.start（mcp-sdk 内部封装）
  await (mcpServer as unknown as { connect: (t: unknown) => Promise<void> }).connect(transport);

  // 子进程在 stdin EOF / signal 时退出；transport.close() 由 McpServer.close 内部调
  // —— 这里只需 await 阻塞防止 Node event loop 提前退出
  await new Promise<void>((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
    process.stdin.on('end', resolve);
  });

  try {
    await (mcpServer as unknown as { close: () => Promise<void> }).close();
  } catch {
    /* ignore */
  }
}
