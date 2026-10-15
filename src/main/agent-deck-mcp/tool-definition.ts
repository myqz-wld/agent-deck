import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/** Transport-neutral definitions; only the Claude server wrapper depends on its SDK. */
export interface AgentDeckToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  // Distinct inferred inputs are erased only at the registry/transport boundary.
  handler: (args: any, extra: unknown) => Promise<CallToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (args: z.output<z.ZodObject<Shape>>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean },
): AgentDeckToolDefinition {
  const metadata: Record<string, unknown> = {};
  if (extras?.searchHint) metadata['anthropic/searchHint'] = extras.searchHint;
  if (extras?.alwaysLoad) metadata['anthropic/alwaysLoad'] = true;
  return {
    name, description, inputSchema, handler,
    annotations: extras?.annotations,
    _meta: Object.keys(metadata).length ? metadata : undefined,
  };
}
