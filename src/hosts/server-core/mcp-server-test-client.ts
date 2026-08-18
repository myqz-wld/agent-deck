import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServerCoreMcpServer } from './mcp-server';

type ServerCoreMcpServer = Awaited<ReturnType<typeof createServerCoreMcpServer>>;

export async function withClient<T>(
  server: ServerCoreMcpServer,
  consume: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-core-mcp-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await consume(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

type ClientToolResult = Awaited<ReturnType<Client['callTool']>>;

export function structuredPayload(result: ClientToolResult): Record<string, unknown> {
  if (result.isError === true) throw new Error('expected MCP success');
  if (!Array.isArray(result.content) || result.content.length !== 0) {
    throw new Error('expected empty MCP success content');
  }
  const value = result.structuredContent;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected MCP structuredContent');
  }
  return value as Record<string, unknown>;
}

export function textPayload(result: ClientToolResult): Record<string, unknown> {
  if (result.structuredContent !== undefined) {
    throw new Error('expected text-only MCP payload');
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('expected MCP content');
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== 'text') throw new Error('expected text result');
  if (typeof first.text !== 'string') throw new Error('expected text payload');
  return JSON.parse(first.text) as Record<string, unknown>;
}
