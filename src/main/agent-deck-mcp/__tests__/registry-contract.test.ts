import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildAgentDeckTools } from '../tools';
import { registerAgentDeckToolDefinitions } from '../server';

vi.mock('@main/adapters/claude-code/sdk-loader', () => ({
  loadSdk: () => { throw new Error('Generic MCP construction must not load Claude'); },
}));

describe('provider-neutral registry contract', () => {
  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'preserves the complete published %s catalog captured before decoupling',
    async (adapterId) => {
      const tools = await buildAgentDeckTools({
        adapterId, transport: 'http', callerSessionIdOverride: () => 'fixture-session',
      });
      const server = new McpServer({ name: 'fixture', version: '1' });
      registerAgentDeckToolDefinitions(server, tools);
      const client = new Client({ name: 'fixture', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const catalog = await client.listTools();
        expect(catalog.tools).toHaveLength(20);
        // Includes descriptions, schemas, defaults, annotations and discovery metadata.
        expect(createHash('sha256').update(JSON.stringify(catalog)).digest('hex')).toMatchSnapshot();
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
