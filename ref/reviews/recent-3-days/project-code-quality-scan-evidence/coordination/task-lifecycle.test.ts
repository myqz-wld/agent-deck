import { it,expect,vi } from 'vitest';
import { createRequire } from 'node:module';
const Database=createRequire(process.cwd()+'/package.json')('better-sqlite3');
const fixture=vi.hoisted(()=>({db:null as any}));
vi.mock('@main/store/db',()=>({getDb:()=>fixture.db,isDbClosed:()=>false}));
import { CURRENT_SCHEMA_SQL } from '@main/store/schema';
import { sessionRepo } from '@main/store/session-repo';
import { createTaskRepo } from '@main/store/task-repo';
import { taskGetHandler } from '@main/agent-deck-mcp/tools/handlers/task-get';
function setup(){
 const db=fixture.db=new Database(':memory:');db.pragma('foreign_keys=ON');db.pragma('trusted_schema=ON');db.exec(CURRENT_SCHEMA_SQL);
 for(const id of ['owner-a','owner-b'])db.prepare(`INSERT INTO sessions(id,agent_id,cwd,title,source,lifecycle,activity,started_at,last_event_at) VALUES (?,'codex-cli','/fixture','fixture','sdk','closed','idle',1,1)`).run(id);
 db.prepare(`UPDATE sessions SET lifecycle='active' WHERE id='owner-b'`).run();
 db.prepare(`INSERT INTO agent_deck_teams(id,name,created_at) VALUES ('team-fixture','fixture',1)`).run();
 for(const id of ['owner-a','owner-b'])db.prepare(`INSERT INTO agent_deck_team_members(team_id,session_id,role,joined_at) VALUES ('team-fixture',?,'teammate',1)`).run(id);
 const tasks=createTaskRepo(db);
 const upstream=tasks.create({ownerSessionId:'owner-a',teamId:'team-fixture',subject:'upstream'});
 const downstream=tasks.create({ownerSessionId:'owner-b',teamId:'team-fixture',subject:'downstream',blockedBy:[upstream.id]});
 tasks.update(upstream.id,{blocks:[downstream.id]});
 return{db,tasks,upstream,downstream};
}
it('explicit task deletion cleans relations as a control',()=>{
 const {db,tasks,upstream,downstream}=setup();
 try {tasks.delete(upstream.id);expect(tasks.get(downstream.id)?.blockedBy).toEqual([]);}finally{db.close();}
});
it('session deletion cascades tasks but leaves dangling dependency UUIDs',()=>{
 const {db,tasks,upstream,downstream}=setup();
 try {sessionRepo.delete('owner-a');expect(tasks.get(upstream.id)).toBeNull();expect(tasks.get(downstream.id)?.blockedBy).toEqual([upstream.id]);console.log('delete cascade',JSON.stringify({upstreamExists:tasks.get(upstream.id)!==null,survivingBlockedBy:tasks.get(downstream.id)?.blockedBy}));}finally{db.close();}
});
it('history retention exposes a dangling dependency to the surviving active teammate',async()=>{
 const {db,tasks,upstream,downstream}=setup();
 try {sessionRepo.batchDeleteHistory([{id:'owner-a',cliSessionId:null,lastEventAt:1}],1000);expect(tasks.get(upstream.id)).toBeNull();expect(tasks.get(downstream.id)?.blockedBy).toEqual([upstream.id]);const result=await taskGetHandler({taskId:downstream.id},{caller:{callerSessionId:'owner-b',transport:'http'}});expect(result.isError).not.toBe(true);expect((result.structuredContent as any).blockedBy).toEqual([upstream.id]);console.log('retention cascade',JSON.stringify({upstreamExists:tasks.get(upstream.id)!==null,survivingOwnerLifecycle:sessionRepo.get('owner-b')?.lifecycle,survivingBlockedBy:(result.structuredContent as any).blockedBy,visibleThrough:'task_get'}));}finally{db.close();}
});
