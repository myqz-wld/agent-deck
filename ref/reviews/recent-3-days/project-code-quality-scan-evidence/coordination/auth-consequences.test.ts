import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const Database=createRequire(process.cwd()+'/package.json')('better-sqlite3');
const fixture=vi.hoisted(()=>({db:null as any}));
vi.mock('@main/store/db',()=>({getDb:()=>fixture.db,isDbClosed:()=>false}));
vi.mock('@main/agent-deck-mcp/tools',()=>({buildAgentDeckTools:vi.fn()}));
import { CURRENT_SCHEMA_SQL } from '@main/store/schema';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { translateUserPromptSubmit,translateSessionEnd } from '@main/adapters/claude-code/hook-lifecycle-translate';
import { resolveCallerSidForReadOnly } from '@main/agent-deck-mcp/transport-http';
import { listSessionsHandler } from '@main/agent-deck-mcp/tools/handlers/list';
import { getSessionHandler } from '@main/agent-deck-mcp/tools/handlers/get';
import { taskListHandler } from '@main/agent-deck-mcp/tools/handlers/task-list';
import { withMcpGuard } from '@main/agent-deck-mcp/tools/helpers';
import { EXTERNAL_CALLER_ALLOWED } from '@main/agent-deck-mcp/types';
beforeAll(()=>{
 fixture.db=new Database(':memory:');
 fixture.db.pragma('foreign_keys=ON'); fixture.db.pragma('trusted_schema=ON'); fixture.db.exec(CURRENT_SCHEMA_SQL);
});
afterAll(()=>fixture.db.close());
it('persists production translated unclaimed CLI hook events, without a provider runtime',()=>{
 const message={...translateUserPromptSubmit({session_id:'attacker-fixture',cwd:'/fixture/cwd',prompt:'fixture forged user prompt'}),source:'hook' as const,hookOrigin:'cli' as const};
 sessionManager.ingest(message);
 const session=sessionRepo.get('attacker-fixture');
 const events=eventRepo.listForSession('attacker-fixture');
 expect(session?.source).toBe('cli');
 expect(events[0].payload).toMatchObject({role:'user',text:'fixture forged user prompt'});
 sessionManager.ingest({...translateSessionEnd({session_id:'attacker-fixture',cwd:'/fixture/cwd',reason:'exit'}),source:'hook',hookOrigin:'cli'});
 expect(sessionRepo.get('attacker-fixture')?.lifecycle).toBe('closed');
 console.log('hook consequence',JSON.stringify({createdSource:session?.source,persistedUserPayload:events[0].payload,finalLifecycle:sessionRepo.get('attacker-fixture')?.lifecycle}));
});
it('missing HTTP auth can read metadata while all external-disallowed tools retain their guard',async()=>{
 sessionManager.ensure('metadata-fixture',{agentId:'codex-cli',cwd:'/fixture/private-project',title:'confidential fixture title',source:'sdk'});
 const ctx={caller:{callerSessionId:resolveCallerSidForReadOnly(undefined),transport:'http' as const}};
 expect(ctx.caller.callerSessionId).toBe('__external__');
 const listed=await listSessionsHandler({statusFilter:'all'},ctx);
 const got=await getSessionHandler({sessionId:'metadata-fixture'},ctx);
 expect(got.structuredContent).toMatchObject({sessionId:'metadata-fixture',cwd:'/fixture/private-project',title:'confidential fixture title'});
 expect((listed.structuredContent as any).sessions.some((s:any)=>s.sessionId==='metadata-fixture')).toBe(true);
 const tasks=await taskListHandler({},ctx);
 expect((tasks.structuredContent as any).tasks).toEqual([]);
 let denied=0;
 for(const [name,allowed] of Object.entries(EXTERNAL_CALLER_ALLOWED)){
  if(allowed)continue;
  const handler=withMcpGuard(name as any,async()=>{throw Error('must not execute');});
  expect((await handler({},ctx)).isError).toBe(true); denied++;
 }
 console.log('MCP consequence',JSON.stringify({identity:ctx.caller.callerSessionId,metadata:got.structuredContent,externalDisallowedGuards:denied,tasks:tasks.structuredContent}));
});
