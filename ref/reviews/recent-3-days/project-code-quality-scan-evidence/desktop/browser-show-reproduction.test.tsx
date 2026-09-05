import { expect, it, vi } from 'vitest';
import { BrowserViewHost } from '@main/browser-use/view-host';
import { BrowserEngine, setBrowserEngine } from '@main/browser-use/engine/registry';
import { executeBrowserOperation } from '@main/browser-use/operation-executor';
import { FakeWindow } from '@main/browser-use/engine/__tests__/_fakes';
import { FakeHostWindow, FakeView } from './browser-fakes';
it('observes open(show=true) report visible while the production default keeps the view parked',async()=>{
 const parking=new FakeHostWindow();
 const view=new FakeView();
 Object.assign(view.webContents,new FakeWindow().webContents);
 const host=new BrowserViewHost({
  createParkingWindow:()=>parking.asWindow(),createView:()=>view.asView(),
  workArea:{x:0,y:0,width:1200,height:800},displayScaleFactor:()=>1,
  // Production bootstrap supplies no onShowRequested callback.
 });
 const present=vi.spyOn(host,'present');
 const engine=new BrowserEngine({createSurface:(options)=>host.createSurface(options)});
 setBrowserEngine(engine);
 try {
  const handle=engine.acquire({kind:'session',id:'show-scan'});
  const result=await executeBrowserOperation({applicationSessionId:'show-scan',handle},{operation:'open',args:{show:true}});
  expect(result.ok).toBe(true);
  if(!result.ok)throw new Error(result.error.message);
  expect(result.data.visible).toBe(true);
  expect(parking.setOpacity).toHaveBeenCalledWith(0);
  expect(parking.children).toContain(view);
  expect(parking.focused).toBe(false);
  expect(present).not.toHaveBeenCalled();
 }finally{await engine.disposeAll();host.dispose();setBrowserEngine(null)}
});
