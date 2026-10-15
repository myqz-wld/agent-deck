const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {pathToFileURL}=require('node:url');const {createRequire}=require('node:module');
const catalog=JSON.parse(fs.readFileSync('/tmp/agent-deck-tool-search-catalog.json','utf8'));
const mode=process.argv[2]||'default';const probeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'deck-claude-search-'));
const requests=[];const mcpMethods=[];const controller=new AbortController();let query;
const server=http.createServer(async(req,res)=>{
 try{const chunks=[];for await(const b of req)chunks.push(b);let body=Buffer.concat(chunks);if(req.headers['content-encoding']==='gzip')body=require('node:zlib').gunzipSync(body);const d=body.length?JSON.parse(body):{};
 if(req.url==='/mcp'){
  if(req.method!=='POST'){res.writeHead(405).end();return;}mcpMethods.push(d.method);
  if(d.id===undefined){res.writeHead(202).end();return;}
  let result=d.method==='initialize'?{protocolVersion:d.params.protocolVersion,serverInfo:{name:'agent-deck',version:'fixture'},capabilities:{tools:{}}}:d.method==='tools/list'?catalog:{};
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:d.id,result}));return;
 }
 if(req.url?.includes('/messages/count_tokens')){res.writeHead(200,{'content-type':'application/json'}).end('{"input_tokens":1000}');return;}
 if(req.url?.startsWith('/v1/messages')){
  requests.push({body:d,beta:req.headers['anthropic-beta']});
  const msg={id:'msg-fixture',type:'message',role:'assistant',model:d.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}};
  let events=[{type:'message_start',message:msg},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Fixture completed.'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:0}},{type:'message_stop'}];
  if(d.tools?.some(t=>t.name==='ToolSearch')&&requests.length===1)events=[{type:'message_start',message:msg},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'fixture-search',name:'ToolSearch',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({query:'+agent-deck list_sessions discover session metadata',max_results:1})}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:0}},{type:'message_stop'}];
  res.writeHead(200,{'content-type':'text/event-stream'}).end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));return;
 }
 res.writeHead(404,{'content-type':'application/json'}).end('{}');
 }catch(e){res.writeHead(500).end(JSON.stringify({error:String(e)}));}
});server.on('connect',(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const sdk=await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
 const env={PATH:process.env.PATH,CLAUDE_CONFIG_DIR:probeRoot,ANTHROPIC_API_KEY:'fixture-not-a-real-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',HTTP_PROXY:`http://127.0.0.1:${port}`,HTTPS_PROXY:`http://127.0.0.1:${port}`,NO_PROXY:'127.0.0.1,localhost'};
 let settings; let cleanupSettings;
 if(mode.startsWith('settings-')) { settings=path.join(probeRoot,'gateway.json');fs.writeFileSync(settings,JSON.stringify({env:{ENABLE_TOOL_SEARCH:mode.slice('settings-'.length)}}),{mode:0o600}); }
 else if(mode.startsWith('derived-')) {
  const source=path.join(probeRoot,'gateway.json');
  fs.writeFileSync(source,JSON.stringify({env:{ENABLE_TOOL_SEARCH:mode.slice('derived-'.length)}}),{mode:0o600});
  const helperPath=path.join(probeRoot,'gateway-settings.cjs');
  const helperSource=fs.readFileSync(path.resolve(__dirname,'../../../../src/main/adapters/claude-code/sdk-bridge/create-session/gateway-sandbox-settings-core.ts'),'utf8');
  const {transformSync}=createRequire(require.resolve('vite/package.json'))('esbuild');
  fs.writeFileSync(helperPath,transformSync(helperSource,{loader:'ts',format:'cjs',platform:'node'}).code,{mode:0o600});
  const prepared=require(helperPath).prepareGatewaySandboxSettingsCore({settingsPath:source,sandboxOpts:{sandbox:{enabled:true,failIfUnavailable:true}}},{
   readSettingsText:p=>fs.readFileSync(p,'utf8'),
   materializeDerivedSettings:text=>{const p=path.join(probeRoot,'derived.json');fs.writeFileSync(p,text,{mode:0o600});return {settingsPath:p,cleanup:()=>fs.rmSync(p,{force:true})};}
  });
  settings=prepared.settingsPath;Object.assign(env,prepared.childEnv);cleanupSettings=prepared.cleanup;
 }
 else if(mode!=='default')env.ENABLE_TOOL_SEARCH=mode;
 const timer=setTimeout(()=>controller.abort(),25000);let error=null;
 try{
 query=sdk.query({prompt:'Reply briefly; this is an isolated tool-definition fixture.',options:{cwd:probeRoot,model:'claude-sonnet-4-6',settingSources:[],...(settings?{settings}:{}),env,abortController:controller,maxTurns:2,persistSession:false,allowedTools:['mcp__agent-deck__*'],mcpServers:{'agent-deck':{type:'http',url:`http://127.0.0.1:${port}/mcp`}}}});
 for await(const m of query){if(m.type==='result')break;}
 }catch(e){error=String(e);}finally{clearTimeout(timer);query?.close();controller.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 fs.writeFileSync(`/tmp/agent-deck-tool-search-claude-${mode}.json`,JSON.stringify({mode,requests,error},null,2),{mode:0o600});
 cleanupSettings?.();fs.rmSync(probeRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 if(error)throw new Error(error);
 const expected=mode.endsWith('true')?0:20;
 if(requests[0]?.body.tools?.filter(t=>t.name?.startsWith('mcp__agent-deck')).length!==expected)throw new Error('Unexpected initial MCP exposure');
 if(expected===0&&requests[1]?.body.tools?.filter(t=>t.name?.startsWith('mcp__agent-deck')).length!==1)throw new Error('Selective discovery did not load exactly one MCP definition');
 console.log(JSON.stringify({mode,mcpMethods,error,requests:requests.map(({body,beta})=>({beta,tools:body.tools?.map(t=>({name:t.name,type:t.type,defer_loading:t.defer_loading})),mcpCount:body.tools?.filter(t=>t.name?.startsWith('mcp__agent-deck')).length,toolsCharacters:JSON.stringify(body.tools||[]).length}))},null,2));
})().catch(e=>{console.error(String(e));query?.close();controller.abort();server.closeAllConnections();server.close();process.exitCode=1;});
