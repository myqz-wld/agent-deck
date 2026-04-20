# CHANGELOG_7: 提示音播放健壮化（Windows mp3 + 防叠播 + 5s 上限）

## 概要

补两条 sound.ts 的隐患：

1. **Windows 之前没法放 mp3** —— 用的 `System.Media.SoundPlayer` 只支持 wav，mp3/aiff/m4a 都失败 → 走系统声音回退。改用 PowerShell + `PresentationCore.MediaPlayer`，支持 mp3/wav/aiff/m4a/wma 等多种格式。
2. **没有播放保护**：用户选了长音频（比如一首 3 分钟的歌）→ 真的会播 3 分钟；期间多次 waiting → 同时拉起多个 afplay 子进程叠音。

加两层保护：
- **防叠播**：全局只允许 1 个外部播放器进程；新触发会 SIGTERM 旧的（断尾，不"叠音轨"）
- **时长上限**：MAX_PLAY_MS = 5000，超过自动 SIGTERM
- 通过 SIGTERM 自然结束的不视为播放失败，不触发回退

## 变更内容

### src/main/notify/sound.ts
- 新增模块级单例 `currentPlayback: { proc, timeout } | null`
- 新增 `killCurrentPlayback()`：clearTimeout + `proc.kill('SIGTERM')`，幂等
- 新增 `trackPlayback(proc)`：每次启动新 player 都先 kill 旧的、设 5s 超时强 kill、监听 exit 自动清理
- `isOurKill(err)` 辅助：根据 `err.signal === 'SIGTERM'` 或 `err.killed === true` 判断"是我们主动 kill 的"，这种不算播放失败，不触发 onError 回退
- 重写 `playFile`：
  - macOS: `execFile('afplay', [file])` + `trackPlayback`
  - Linux: paplay → 失败回退 aplay，两段都走 `trackPlayback`
  - Win: `execFile('powershell', ['-NoProfile', '-Command', script])`，script 用 `Add-Type PresentationCore` + `MediaPlayer.Open(Uri).Play()` + `Start-Sleep MAX_PLAY_MS` + `Stop/Close`；路径用 `file:///` 前缀 + 反斜杠转正斜杠 + 双引号转义 `""`
  - 未知平台：直接 `onError()`
- `playSystemBeep` 也用 `trackPlayback`，避免系统声音和真正的提示音叠播
- 新导出 `stopAllSounds()`：调用 `killCurrentPlayback`，给 `before-quit` 用

### src/main/index.ts
- import `stopAllSounds`
- `before-quit` 钩子里调一次 `stopAllSounds()`，保证退出时杀掉残留的 afplay / PowerShell 子进程

### 文档
- `README.md` 「控制权交接判定」一节：补「播放保护」「跨平台播放命令」两行
- 本文件 + `INDEX.md` 同步

## 备注
- Windows PowerShell 启动开销 ~200-500ms，每次提示音都会启一个新进程；考虑到 5s 上限和防叠播，影响可控
- macOS `afplay` 收到 SIGTERM 立即停止，平滑无杂音；Linux paplay 同理；Windows MediaPlayer 我用 Start-Sleep 等待 5s 后主动 Stop()，被 kill 时 .NET 进程被强终结，没有"软停"动画
- 不过 5 秒对提示音绝对够（典型提示音 < 2s）；想关掉「截断」就把 MAX_PLAY_MS 改大
