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

export function payload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('expected MCP content');
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== 'text') throw new Error('expected text result');
  if (typeof first.text !== 'string') throw new Error('expected text payload');
  return JSON.parse(first.text) as Record<string, unknown>;
}
