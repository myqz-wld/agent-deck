import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFileChanges } from '@renderer/components/SessionDetail/use-file-changes';
import { useRemoteHostSnapshot } from '@renderer/remote-host/use-remote-host-snapshot';
import { sourceCallback } from './source-selection-callback';
function deferred<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; }
const flush = async () => { for(let i=0;i<25;i++) await Promise.resolve(); };
const summary=(id:number)=>({id,sessionId:'s1',filePath:`project/${id}.ts`,kind:'text',toolCallId:null,ts:id,hasBeforeBlob:false,hasAfterBlob:false,hasBeforeSnapshot:false,hasAfterSnapshot:false});
afterEach(()=>{cleanup();vi.useRealTimers()});
it('observes stale Diff data after leaving and reopening the same session tab', async()=>{
 let records=[summary(1)];
 const listeners=new Set<(event:any)=>void>();
 const list=vi.fn(async()=>({items:[...records],nextCursor:null}));
 Object.defineProperty(window,'api',{configurable:true,value:{listFileChangePage:list,onAgentEvent:(f:any)=>{listeners.add(f);return()=>listeners.delete(f)}}});
 const h=renderHook(({enabled})=>useFileChanges({sessionId:'s1',enabled}),{initialProps:{enabled:true}});
 await act(flush);
 expect(h.result.current.changes?.map(x=>x.id)).toEqual([1]);
 h.rerender({enabled:false});
 expect(listeners.size).toBe(0);
 records=[summary(2),summary(1)];
 for(const listener of listeners) listener({kind:'file-changed',sessionId:'s1'});
 h.rerender({enabled:true});
 await act(flush);
 expect(list).toHaveBeenCalledTimes(1);
 expect(h.result.current.changes?.map(x=>x.id)).toEqual([1]);
 // New records exist in the supported IPC response; re-entry never asks for them.
 expect((await list()).items.map(x=>x.id)).toEqual([2,1]);
});
it('observes lost initial cursor when an incremental refresh supersedes first-page load', async()=>{
 vi.useFakeTimers();
 const initial=deferred<any>();
 let listener:(event:any)=>void=()=>{};
 const list=vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue({items:[summary(2)],nextCursor:'older'});
 Object.defineProperty(window,'api',{configurable:true,value:{listFileChangePage:list,onAgentEvent:(f:any)=>{listener=f;return()=>{}}}});
 const h=renderHook(()=>useFileChanges({sessionId:'s1',enabled:true}));
 await act(flush);
 act(()=>listener({kind:'file-changed',sessionId:'s1'}));
 await act(async()=>{await vi.advanceTimersByTimeAsync(300); await flush()});
 expect(list).toHaveBeenCalledTimes(2);
 expect(h.result.current.changes?.map(x=>x.id)).toEqual([2]);
 expect(h.result.current.hasMore).toBe(false);
 await act(async()=>{initial.resolve({items:[summary(1)],nextCursor:'older'});await flush()});
 expect(h.result.current.hasMore).toBe(false);
 await act(async()=>{await h.result.current.loadMore()});
 expect(list).toHaveBeenCalledTimes(2);
});
it('observes a prior Remote choice overwrite a newer Local choice through the actual App callback', async()=>{
 const selected=deferred<void>();
 let snapshot:any={revision:1,sourceMode:'local',selectedRemoteProfileId:null,profiles:[{id:'profile-b',scope:'remote',label:'Remote B',endpoint:null}],states:[{profileId:'profile-b',status:'connected',authoritativeCoreId:'core-b',workerGeneration:null,capabilities:[]}]};
 const calls:string[]=[];
 const setMode=vi.fn(async(mode:string)=>{calls.push(mode); snapshot={...snapshot,revision:snapshot.revision+1,sourceMode:mode};return snapshot});
 Object.defineProperty(window,'api',{configurable:true,value:{
   getRemoteHostSnapshot:vi.fn(async()=>snapshot), onRemoteHostChanged:()=>()=>{},
   selectRemoteHostProfile:vi.fn(async(id:string)=>{await selected.promise;snapshot={...snapshot,revision:snapshot.revision+1,selectedRemoteProfileId:id};return snapshot}),
   setRemoteHostSourceMode:setMode,
 }});
 const h=renderHook(()=>useRemoteHostSnapshot());
 await act(flush);
 const choose=sourceCallback(h.result.current,{warn:vi.fn()});
 act(()=>{choose('remote:profile-b');choose('local')});
 await act(flush);
 await act(async()=>{selected.resolve();await flush()});
 expect(calls).toEqual(['local','remote']);
 expect(h.result.current.snapshot?.sourceMode).toBe('remote');
});
it('observes an inaccessible revision after a supported 51-file event burst on an exhausted list', async()=>{
 vi.useFakeTimers();
 let records=[summary(1)];
 let listener:(event:any)=>void=()=>{};
 const list=vi.fn(async(_sid:string, options:any)=>{
   const start=options.cursor===undefined?0:Number(options.cursor);
   return {items:records.slice(start,start+50),nextCursor:records.length>start+50?String(start+50):null};
 });
 Object.defineProperty(window,'api',{configurable:true,value:{listFileChangePage:list,onAgentEvent:(f:any)=>{listener=f;return()=>{}}}});
 const h=renderHook(()=>useFileChanges({sessionId:'s1',enabled:true}));
 await act(flush);
 expect(h.result.current.hasMore).toBe(false);
 records=Array.from({length:52},(_,i)=>summary(52-i));
 act(()=>{for(let id=2;id<=52;id++)listener({kind:'file-changed',sessionId:'s1',payload:{filePath:`project/${id}.ts`}})});
 await act(async()=>{await vi.advanceTimersByTimeAsync(300);await flush()});
 const ids=h.result.current.changes!.map(x=>x.id);
 expect(ids).toHaveLength(51);
 expect(ids).not.toContain(2);
 expect(h.result.current.hasMore).toBe(false);
 await act(async()=>{await h.result.current.loadMore()});
 expect(list).toHaveBeenCalledTimes(2);
 expect((await list('s1',{limit:50})).nextCursor).toBe('50');
});
