import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildAgentDeckTools } from '../../../../src/main/agent-deck-mcp/tools';
import { registerAgentDeckToolDefinitions } from '../../../../src/main/agent-deck-mcp/server';
it('exports the public tool catalog to the isolated provider fixture', async () => {
 const defs = await buildAgentDeckTools({ adapterId: 'codex-cli', transport: 'http', callerSessionIdOverride: () => 'fixture' });
 const server = new McpServer({name:'agent-deck',version:'fixture'});
 registerAgentDeckToolDefinitions(server,defs);
 const client = new Client({name:'fixture',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try { const catalog=await client.listTools();expect(catalog.tools).toHaveLength(20);
 writeFileSync('/tmp/agent-deck-tool-search-catalog.json',JSON.stringify(catalog));
 console.log(JSON.stringify({count:catalog.tools.length,characters:JSON.stringify(catalog).length,
 longestDescriptions:catalog.tools.map(t=>({name:t.name,length:t.description?.length??0})).sort((a,b)=>b.length-a.length).slice(0,5)}));
 } finally {await client.close();await server.close();}
});
