const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const {createInterface}=require('node:readline');
const catalog=JSON.parse(fs.readFileSync('/tmp/agent-deck-tool-search-catalog.json','utf8'));
const pkgReq=createRequire(require.resolve('@openai/codex/package.json'));
const binary=path.join(path.dirname(pkgReq.resolve('@openai/codex-darwin-arm64/package.json')),'vendor','aarch64-apple-darwin','bin','codex');
const probeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'deck-tool-search-'));
const requests=[]; const mcpMethods=[]; let providerN=0; let child; let stderr=''; let finishedResolve;
const finished=new Promise(resolve=>finishedResolve=resolve);
const model=process.argv[2]||'gpt-6-sol'; const mode=process.argv[3]||'default';
const server=http.createServer(async(req,res)=>{
 try {
  let chunks=[]; for await(const b of req)chunks.push(b);
  let body=Buffer.concat(chunks); if(req.headers['content-encoding']==='gzip')body=require('node:zlib').gunzipSync(body);
  if(req.headers['content-encoding']==='zstd') throw new Error('zstd fixture body unsupported');
  const data=body.length?JSON.parse(body):null;
  if(req.url==='/mcp'){
   if(req.method!=='POST'){res.writeHead(405).end();return;}
   mcpMethods.push(data.method);
   if(data.id===undefined){res.writeHead(202).end();return;}
   let result;
   if(data.method==='initialize')result={protocolVersion:data.params.protocolVersion,serverInfo:{name:'agent-deck',version:'fixture'},capabilities:{tools:{listChanged:true}},instructions:'Agent Deck session collaboration, task management, plans, and worktrees.'};
   else if(data.method==='tools/list')result=catalog;
   else if(data.method==='tools/call')result={content:[{type:'text',text:'Fixture tool succeeded.'}]};
   else if(data.method==='resources/list')result={resources:[]};
   else if(data.method==='resources/templates/list')result={resourceTemplates:[]};
   else result={};
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:data.id,result}));return;
  }
  if(req.url?.includes('/responses')){
   requests.push(data);const seq=++providerN;
   const events=[{type:'response.created',response:{id:'fixture-response-'+seq}}];
   const modelTools=[...(data.tools||[]),...(data.input||[]).filter(x=>x.type==='additional_tools').flatMap(x=>x.tools||[])];
   const hasSearch=modelTools.some(t=>t.type==='tool_search');
   const hasExec=modelTools.some(t=>t.type==='namespace'&&t.tools?.some(c=>c.name==='exec'));
   if(seq===1&&hasSearch) events.push({type:'response.output_item.done',item:{type:'tool_search_call',call_id:'fixture-search',execution:'client',arguments:{query:'agent-deck list_sessions discover session metadata',limit:1}}});
   else if(seq===1&&hasExec) events.push({type:'response.output_item.done',item:{type:'custom_tool_call',call_id:'fixture-exec',namespace:'functions',name:'exec',input:"text(ALL_TOOLS.filter(t => t.name.includes('agent_deck') && t.name.endsWith('list_sessions')));"}});
   else events.push({type:'response.output_item.done',item:{type:'message',id:'fixture-message',role:'assistant',content:[{type:'output_text',text:'Fixture completed.'}]}});
   events.push({type:'response.completed',response:{id:'fixture-response-'+seq,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));return;
  }
  if(req.url?.endsWith('/models')){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[]}));return;}
  res.writeHead(404).end('{}');
 }catch(error){res.writeHead(500).end(JSON.stringify({error:String(error)}));}
});
server.on('connect',(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 let config=`model = "${model}"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[analytics]\nenabled = false\n`;
 let catalogPath;
 if(mode.startsWith('catalog-')) {
  const source=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
  const entry={...source.models.find(m=>m.slug==='gpt-6-sol'),slug:model,display_name:'Fixture model'};
  catalogPath=path.join(probeRoot,'model-catalog.json');fs.writeFileSync(catalogPath,JSON.stringify({models:[entry]}));
  if(mode==='catalog-startup')config=`model_catalog_json = ${JSON.stringify(catalogPath)}\n`+config;
 }
 fs.writeFileSync(path.join(probeRoot,'config.toml'),config,{mode:0o600});
 child=spawn(binary,[...(mode==='catalog-argv'?['-c',`model_catalog_json=${JSON.stringify(catalogPath)}`]:[]),'app-server','--stdio'],{cwd:probeRoot,env:{PATH:process.env.PATH,CODEX_HOME:probeRoot,RUST_LOG:'error',HTTP_PROXY:`http://127.0.0.1:${port}`,HTTPS_PROXY:`http://127.0.0.1:${port}`,NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']});
 child.stderr.on('data',b=>stderr+=b.toString());
 let nextId=0;const pending=new Map();
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method));},20000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{let obj;try{obj=JSON.parse(line)}catch{return}
  if(obj.id!==undefined&&pending.has(obj.id)){const p=pending.get(obj.id);pending.delete(obj.id);obj.error?p.reject(new Error(JSON.stringify(obj.error))):p.resolve(obj.result);}
  if(obj.method==='turn/completed')finishedResolve();
  if(obj.method&&obj.id!==undefined)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:obj.id,error:{code:-32601,message:'No approvals in fixture'}})+'\n');
 });
 child.on('exit',()=>finishedResolve());
 const timeout=setTimeout(()=>{finishedResolve();},35000);
 try {
  await rpc('initialize',{clientInfo:{name:'agent-deck-fixture',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}})+'\n');
  const thread=await rpc('thread/start',{cwd:probeRoot,model,modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only',ephemeral:true,baseInstructions:'Isolated fixture: use only the supplied fake MCP catalog.',developerInstructions:'Never access external resources.',config:{...(mode==='catalog-thread'?{model_catalog_json:catalogPath}:{}),mcp_servers:{'agent-deck':{url:`http://127.0.0.1:${port}/mcp`,required:true}}}});
  await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Find the tool for listing Agent Deck sessions.',text_elements:[]}]});
  await finished;
  const summaries=requests.map(r=>{
   const specs=[...(r.tools||[]),...(r.input||[]).filter(x=>x.type==='additional_tools').flatMap(x=>x.tools||[])];
   const raw=JSON.stringify(r); const nested=specs.flatMap(t=>t.tools||[t]);
   return {requestCharacters:raw.length,toolsCharacters:JSON.stringify(specs).length,
    tools:nested.map(t=>({type:t.type,name:t.name})),
    descriptionsEmbedded:catalog.tools.filter(t=>raw.includes(JSON.stringify(t.description).slice(1,-1))).map(t=>t.name),
    directToolDescriptionsEmbedded:catalog.tools.filter(t=>JSON.stringify(specs).includes(JSON.stringify(t.description).slice(1,-1))).map(t=>t.name),
    discoveryOutputs:(r.input||[]).filter(t=>['tool_search_output','custom_tool_call_output','function_call_output'].includes(t.type))};
  });
  fs.writeFileSync(`/tmp/agent-deck-tool-search-${model}-${mode}.json`,JSON.stringify({model,mcpMethods,requests,stderr},null,2),{mode:0o600});
  console.log(JSON.stringify({model,mode,providerRequests:requests.length,mcpMethods,summaries},null,2));
  if(!requests.length)throw new Error('No inference request captured');
  const deferred=['catalog-startup','catalog-argv'].includes(mode)||(model==='gpt-6-sol'&&mode==='default');
  if(summaries[0].directToolDescriptionsEmbedded.length!==(deferred?0:20))throw new Error('Unexpected initial MCP exposure');
  if(deferred&&JSON.stringify(summaries[1]?.descriptionsEmbedded)!==JSON.stringify(['list_sessions']))throw new Error('Selective discovery did not load exactly list_sessions');
 } finally {clearTimeout(timeout); child.stdin.end();if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;} lines.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(probeRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(String(error));console.error(stderr.slice(-1600));if(child?.exitCode===null)child.kill('SIGTERM');server.close();process.exitCode=1;});
