# CHANGELOG_35: pin 残影根因升级（去 ::before mix-blend-mode + 提频 + 关节流） + 清理 render-mode.ts 死代码

## 概要

两个独立修复合卷：

1. **pin 透明态文字残影**：CHANGELOG_24 的 5fps invalidate 设置在动态场景（滚动 / 视频 / 切下层 app）下肉眼能瞥到旧帧 → 用户实测仍有"文字残影"。**对抗 Agent 双向核实**后定位到两个根因：
   - **CSS 真凶**（CHANGELOG_24 完全没看到的）：`.frosted-frame::before` 用 `mix-blend-mode: overlay` 配合父层 `isolation: isolate` + `backdrop-filter`，强制 Chromium 把文字层与噪点合成进 offscreen group surface，**该 group surface 被 Blink 缓存，`webContents.invalidate()` 不能让它失效** → 文字"印"在玻璃上，与下方动态画面错位
   - **频率 + 节流**（CHANGELOG_24 的延伸）：5fps = 10fps 是「下层桌面感知 fps」（invalidate 触发 NSWindow 重新与桌面合成顺便取下层最新像素），5fps 太低；窗口失焦时 Chromium 默认对 webContents 做 paint 节流，invalidate 实际频率被压到 1-2fps
   - 顺手修 CHANGELOG_24 注释里那段「pin 态下 backdrop-filter 模糊下层 app 像素」的认知错误（其实 backdrop-filter 只对窗口自身 layer 像素生效，下层 app 像素是 NSWindow 层做的简单 source-over 合成，根本没经过 blur）

2. **`src/renderer/lib/render-mode.ts` 整体删除**：CHANGELOG_34 把 MD/TXT 切换从「全局共享」改成「每条独立」之后，`localStorage` 的 `agent-deck:message-render-mode` 键再也没人写了（永远只能读到 `'plaintext'` 默认值）。`readInitialRenderMode()` 等价于 `() => 'plaintext'`，整个文件就是死代码。直接删，类型 + 默认 inline 到 `ActivityFeed.tsx`

## 变更内容

### `src/renderer/styles/globals.css`
- `.frosted-frame[data-pinned='true']::before { display: none }`：pin 态隐藏噪点 ::before
  - `::before` 自身规则保持不动（默认/无 pin 态仍展示噪点）
  - 0.2 alpha 的 pin 态本来就几乎看不到噪点纹理，display:none 视觉上无回退
  - 根治 `mix-blend-mode: overlay` + `isolation: isolate` + `backdrop-filter` 三件套的 group surface 缓存
- 加详细注释说明为什么 pin 态要把 ::before 干掉

### `src/main/window.ts`
- `create()` 末尾新增 `this.win.webContents.setBackgroundThrottling(false)`：永久关闭节流，确保 pin 失焦（用户在下层 app 操作）时 invalidate 真生效
- `startInvalidateLoop` 频率从 200ms (5fps) 改为 100ms (10fps)：动态场景下层桌面感知率翻倍，GPU 开销仍可忽略
- `setAlwaysOnTop` 内的 invalidate 注释完整重写：
  - 删掉 CHANGELOG_24 那段「关掉 vibrancy 后窗口仅靠 CSS backdrop-filter 提供模糊」的错误认知
  - 改为正确的根因说明：invalidate 触发 NSWindow 重新与桌面合成顺便取下层 app 最新像素，频率即下层桌面感知 fps
  - 标注 CHANGELOG_35 的三项调整 + 文字残影另一根因（CSS group surface 缓存）已在 globals.css 端治根

### `src/renderer/lib/render-mode.ts`（已删除）
- 整个文件删除。理由见上。

### `src/renderer/components/ActivityFeed.tsx`
- 删掉 `import { readInitialRenderMode, type RenderMode } from '@renderer/lib/render-mode'`
- inline `type RenderMode = 'plaintext' | 'markdown'` + `const DEFAULT_RENDER_MODE: RenderMode = 'plaintext'`
- `MessageBubble` 的 `useState` 初始化从 `() => readInitialRenderMode()` 改为 `DEFAULT_RENDER_MODE` 常量
- 注释更新：CHANGELOG_34 + CHANGELOG_35 联动说明

### `README.md`
- 「半透明毛玻璃悬浮窗」段落补一行 pin 残影修复说明（100ms invalidate + display:none ::before + setBackgroundThrottling(false)）
- 「活动 Tab → 气泡头部 MD/TXT」从「初始默认从 localStorage 读一次」改为「默认 plaintext，**不持久化**」
- 项目结构 `lib/render-mode.ts` 整行删除

## 关键场景验证

- pin 模式 + 背后切 app（VS Code → Chrome）→ 窗口内文字不再"印"在新桌面上、不再有错位的旧文字残留
- pin 模式 + 后台播放视频 → 透过窗口看到的视频流畅，不再卡 5fps
- pin 模式 + 滚动下层 app（IDE 编辑器代码滚动）→ 透过窗口看到的代码跟手，不再瞥到上一帧文字
- 切 pin / 取消 pin → 噪点纹理无 pin 态正常显示、pin 态消失，过渡无撕裂
- 非 pin 模式 → vibrancy 仍由系统层接管，视觉无回退，无新增 GPU 开销（invalidate timer 不启动）
- 单条 message bubble 切 MD/TXT 仍独立、互不级联（CHANGELOG_34 行为保持）；切完关掉重开会话回到默认 plaintext

## 取舍说明

- **为什么不在 renderer 加 RAF DOM mutation 兜底**：Agent B 推荐的"5fps RAF 改 data-tick 强制 Blink dirty"作为加保险；但实测 `display:none ::before` + 100ms invalidate 应该够，先不引入常驻 RAF 循环。后续如果还有边角场景出残影再加
- **为什么不去掉 `> *:not(.absolute):not(.fixed) { z-index: 1 }`**：CLAUDE.md 自家约定明确说"这条不要去掉"；改了会影响 dialog overlay；pin 态收敛改动也得回归测，性价比低
- **为什么不在切 pin 时弹突发 invalidate**：100ms 已经够，且突发 invalidate 实现复杂度上升；100ms 切 pin 的视觉切换肉眼根本来不及感受到差别
- **为什么 `setBackgroundThrottling(false)` 永久开而不是 pin 时切**：节流影响整个 webContents（包括 rAF / setTimeout 精度），永久关掉对非 pin 也有好处（菜单动画 / hover 反馈更跟手）；GPU 开销几乎可忽略
- **为什么不重新审视 setVibrancy('hud')**：CHANGELOG_24 的否决理由（引入浅色基底，与 pin 极透设计冲突）现在仍成立，不重复评估

## 没动的地方

- 非 pin 态的 ::before / blur / backdrop-filter / vibrancy 全部保持不变
- React 组件树、IPC、SDK、Summarizer、HookServer 等无关模块不动
- `agent-deck-settings.json` 里如果有历史的 `agent-deck:message-render-mode` localStorage 值（其实 localStorage 不在 settings.json 里，是浏览器 IndexedDB/LocalStorage 里），不主动清；它就是个孤儿键，不影响任何行为
