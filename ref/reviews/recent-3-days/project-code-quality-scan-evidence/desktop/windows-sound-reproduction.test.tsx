import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({
  path:'C:\\Sounds\\$(Write-Output SCAN_MARKER).wav',
  exec:vi.fn(()=>({once:vi.fn(),kill:vi.fn()})),
}));
vi.mock('node:child_process',()=>({execFile:mocks.exec,default:{execFile:mocks.exec}}));
vi.mock('node:fs',()=>({existsSync:(value:string)=>value===mocks.path,default:{existsSync:(value:string)=>value===mocks.path}}));
vi.mock('@main/platform',()=>({IS_DARWIN:false,IS_LINUX:false,IS_WIN:true}));
vi.mock('@main/store/settings-store',()=>({settingsStore:{getAll:()=>({waitingSoundPath:mocks.path,finishedSoundPath:null})}}));
import { playSoundOnce, stopAllSounds } from '@main/notify/sound';
afterEach(()=>{stopAllSounds();vi.useRealTimers()});
it('observes unescaped filename subexpression inside the Windows PowerShell command',()=>{
 vi.useFakeTimers();
 playSoundOnce('waiting');
 expect(mocks.exec).toHaveBeenCalledOnce();
 const [binary,args]=mocks.exec.mock.calls[0] as unknown as [string,string[]];
 expect(binary).toBe('powershell');
 expect(args.slice(0,2)).toEqual(['-NoProfile','-Command']);
 expect(args[2]).toContain('$p.Open([Uri]::new("file:///C:/Sounds/$(Write-Output SCAN_MARKER).wav"))');
 expect(args[2]).not.toContain('`$');
 // The process boundary is mocked; no executable or media file is opened.
});
