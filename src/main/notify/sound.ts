import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { settingsStore } from '@main/store/settings-store';
import { IS_DARWIN, IS_LINUX, IS_WIN } from '@main/platform';

type SoundKind = 'waiting' | 'done';

/**
 * 跨平台播放短音效。优先级：
 *   1. 用户在设置面板里选的自定义文件（settings.waitingSoundPath / finishedSoundPath）
 *   2. resources/sounds/waiting.m4a / done.m4a（应用内置默认音）
 *   3. 系统提示音（macOS Glass / Tink；Linux/Win 用 \\x07）
 *
 * 内置音用 m4a 格式：macOS afplay / Win MediaPlayer 都原生支持；
 * Linux paplay/aplay 看 magic bytes 不依赖扩展名。
 *
 * 播放策略：
 *   - 防叠播：全局只允许一个外部播放器进程；新触发会 SIGTERM 旧的（断尾，不会"叠音轨"）
 *   - 时长上限：MAX_PLAY_MS（默认 5s），用户即便选了长音频也只放前 5s 后强制结束
 *   - 通过 SIGTERM 自然结束的不视为播放失败，不触发回退
 *
 * 平台命令：
 *   - macOS:  afplay <file>          —— 原生支持 mp3/wav/aiff/m4a/aac/...
 *   - Linux:  paplay → 失败回退 aplay
 *   - Win:    PowerShell + PresentationCore.MediaPlayer
 *             支持 mp3/wav/aiff/m4a 等多种格式（不像 SoundPlayer 只支持 wav）
 */

const MAX_PLAY_MS = 5000;

let currentPlayback: { proc: ChildProcess; timeout: NodeJS.Timeout } | null = null;

function killCurrentPlayback(): void {
  if (!currentPlayback) return;
  clearTimeout(currentPlayback.timeout);
  try {
    currentPlayback.proc.kill('SIGTERM');
  } catch {
    // ignore
  }
  currentPlayback = null;
}

/**
 * 把刚启动的播放进程登记成「当前播放」，旧的会被 kill；
 * 同时挂 setTimeout，超过 MAX_PLAY_MS 仍未自然结束就强制 kill 截断。
 */
function trackPlayback(proc: ChildProcess): void {
  killCurrentPlayback();
  const timeout = setTimeout(() => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }, MAX_PLAY_MS);
  currentPlayback = { proc, timeout };
  proc.once('exit', () => {
    if (currentPlayback?.proc === proc) {
      clearTimeout(currentPlayback.timeout);
      currentPlayback = null;
    }
  });
}

interface ExecError extends Error {
  signal?: string;
  killed?: boolean;
  code?: number | string;
}

/**
 * 是否「我们主动 kill 的」（截断 / 防叠播）—— 这种不算播放失败。
 *
 * 平台细节：
 * - macOS / Linux：`proc.kill('SIGTERM')` 后 child_process 把 `err.signal === 'SIGTERM'`
 * - Win：Win32 `TerminateProcess` 不通过 POSIX signal 模型；`err.signal` 通常为 null，
 *   但 child_process 会把 `err.killed === true` —— 所以 `||` 兜底必须有
 *   （signal 单独判断在 Win 上 100% 漏判，会误触 onError 走 system-beep 退化）
 */
function isOurKill(err: ExecError | null): boolean {
  if (!err) return false;
  return err.signal === 'SIGTERM' || err.killed === true;
}

function resolveSoundFile(kind: SoundKind): string | null {
  // 1. 自定义路径
  const settings = settingsStore.getAll();
  const customPath =
    kind === 'waiting' ? settings.waitingSoundPath : settings.finishedSoundPath;
  if (customPath && existsSync(customPath)) return customPath;

  // 2. 内置默认（resources/sounds/waiting.m4a 或 done.m4a，跟随应用打包）
  //
  // 路径解析：
  // - dev: app.getAppPath() = 仓库根目录 → 直接拼 resources/sounds/<file>
  // - 打包: app.getAppPath() = .../app.asar；afplay 等子进程拿 asar 内路径会 ENOTDIR
  //   （codex binary 同款问题）。必须走 extraResources copy 出来的 unpacked 副本：
  //   process.resourcesPath/sounds/<file>（package.json extraResources sounds → sounds 已配）
  const filename = kind === 'waiting' ? 'waiting.m4a' : 'done.m4a';
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'sounds', filename)
    : join(app.getAppPath(), 'resources', 'sounds', filename);
  if (existsSync(bundled)) return bundled;

  return null;
}

function playFile(file: string, onError: () => void): void {
  if (IS_DARWIN) {
    const proc = execFile('afplay', [file], (err) => {
      if (err && !isOurKill(err as ExecError)) onError();
    });
    trackPlayback(proc);
    return;
  }

  if (IS_LINUX) {
    const tryAplay = (): void => {
      const p2 = execFile('aplay', [file], (err) => {
        if (err && !isOurKill(err as ExecError)) onError();
      });
      trackPlayback(p2);
    };
    const p1 = execFile('paplay', [file], (err) => {
      if (!err) return;
      if (isOurKill(err as ExecError)) return;
      // paplay 失败（多半是没装 PulseAudio）→ 退到 aplay
      tryAplay();
    });
    trackPlayback(p1);
    return;
  }

  if (IS_WIN) {
    // PresentationCore 的 MediaPlayer 支持 mp3/wav/aiff/m4a/wma 等格式（不像
    // System.Media.SoundPlayer 只支持 wav）。注意 PowerShell 字符串里 ` 是转义符，
    // " 在双引号字符串里要写成 ""。Windows 路径用 file:/// 前缀更稳。
    //
    // 已知限制：PresentationCore 是 .NET Framework WPF 程序集，**Win Server Core /
    // 部分裁剪版 Win 镜像**可能未装；那种环境下 `Add-Type -AssemblyName PresentationCore`
    // 抛 FileNotFoundException → execFile err 不是 SIGTERM → 自动 fallback 到 system beep。
    // 主流消费者 Win 10/11（Pro / Home / Enterprise）默认装齐，不需要额外动作。
    const uri = 'file:///' + file.replace(/\\/g, '/');
    const escaped = uri.replace(/`/g, '``').replace(/"/g, '""');
    const psScript =
      'Add-Type -AssemblyName PresentationCore;' +
      '$p = New-Object System.Windows.Media.MediaPlayer;' +
      `$p.Open([Uri]::new("${escaped}"));` +
      '$p.Play();' +
      `Start-Sleep -Milliseconds ${MAX_PLAY_MS};` +
      '$p.Stop();$p.Close()';
    const proc = execFile('powershell', ['-NoProfile', '-Command', psScript], (err) => {
      if (err && !isOurKill(err as ExecError)) onError();
    });
    trackPlayback(proc);
    return;
  }

  onError();
}

function playSystemBeep(kind: SoundKind): void {
  if (IS_DARWIN) {
    // waiting 用清脆的 Glass，finished 用柔和的 Tink。Sosumi 是错误音、太突兀。
    const sound = kind === 'waiting' ? 'Glass' : 'Tink';
    const proc = execFile('afplay', [`/System/Library/Sounds/${sound}.aiff`], () => {});
    trackPlayback(proc);
    return;
  }
  if (IS_WIN) {
    // 用 PowerShell `[console]::beep(freq,ms)`：waiting 调高频短促 / finished 中频较长，听感对齐 macOS Glass/Tink。
    // PresentationCore 兜底失败时也会走到这里（playFile onError）。
    // GUI 进程没有控制台时 [console]::beep 会通过系统扬声器经 IO ctl 出声，与终端无关。
    const args = kind === 'waiting' ? '1000,150' : '600,250';
    const proc = execFile('powershell', ['-NoProfile', '-Command', `[console]::beep(${args})`], () => {});
    trackPlayback(proc);
    return;
  }
  // Linux GUI 进程 stdout 一般无终端附着，BEL 不一定听得到；保留作最简兜底（用户自行配
  // PulseAudio / aplay 才有真音效）
  process.stdout.write('\x07');
}

export function playSoundOnce(kind: SoundKind): void {
  const file = resolveSoundFile(kind);
  if (file) {
    playFile(file, () => playSystemBeep(kind));
  } else {
    playSystemBeep(kind);
  }
}

/** 给应用关闭时清理用，避免残留 afplay/PowerShell 子进程 */
export function stopAllSounds(): void {
  killCurrentPlayback();
}
