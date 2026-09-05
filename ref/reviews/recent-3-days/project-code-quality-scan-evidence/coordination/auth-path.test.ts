import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { HookServer } from '@main/hook-server/server';
const require = createRequire(process.cwd()+'/package.json');
const inject = createRequire(require.resolve('fastify'))('light-my-request');

describe('coordination-01 raw request-target authentication probe', () => {
  it('compares normal, encoded, and absolute targets with no auth token and no listening socket', async () => {
    const server = new HookServer(47821, 'fixture-hook-token', 'fixture-mcp-token');
    for (const url of ['/hook/test', '/mcp']) {
      server.registerRoute({method:'POST', url, handler:async(request,reply)=>reply.send({executed:true,url:request.url,auth: (request.raw as any).auth??null})});
    }
    const app = (server as any).app;
    await app.ready();
    const targets=['/hook/test','/%68ook/test','/h%6fok/test','http://localhost/hook/test','/mcp','/%6dcp','http://localhost/mcp'];
    const results=[];
    for (const target of targets) {
      const response=await inject((req:any,res:any)=>{req.url=target; app.server.emit('request',req,res);},{method:'POST',url:'/unused',payload:{}});
      results.push({target,status:response.statusCode,body:response.json()});
    }
    console.log(JSON.stringify(results,null,2));
    expect(results[0].status).toBe(401);
    expect(results[4].status).toBe(401);
    expect(results.some(r=>r.status===200)).toBe(true);
    await app.close();
  });
});
