# CHANGELOG_34: MessageBubble MD/TXT 切换改为单条独立（推翻 CHANGELOG_27 全局级联）

## 概要

CHANGELOG_27 引入消息气泡 MD/TXT 切换时的取舍是：「切单条 = 切全局，所有 bubble 一起翻面，避免按 message id 存 map 的复杂度」。
实测反馈：用户希望对单条消息独立切换（一段长 markdown 切到 MD 看排版，旁边的纯文本消息保留 TXT），现在级联会把所有消息一起翻得很烦。

本次改造：
- 切单条只改本条的本地 state，**不写 localStorage、不广播**，互不级联
- localStorage 里的值仍然作为「新 mount 的 bubble 启动默认」，但目前 UI 上没有改它的入口（CHANGELOG_27 的 SettingsDialog 也没有暴露）；未来如果要"全局默认 → markdown"，再独立加按钮
- **不持久化「按 message id 存偏好 map」**：CHANGELOG_27 已经反对过这个复杂度，本次仍然不做。后果：切过的 bubble 卸载（切会话 / 应用重启）后回到默认；用户再次进入会话需要重切。这是有意为之

## 变更内容

### `src/renderer/lib/render-mode.ts`
- 删除 `useGlobalRenderMode` hook + `write` + `EVENT_NAME` + 自定义事件 / storage 监听（不再有"全局变化广播"的概念）
- 保留 `RenderMode` 类型；把内部 `read()` 改为 export `readInitialRenderMode()`，命名表达「仅作初始默认值」语义
- 注释更新：标注 CHANGELOG_27 → CHANGELOG_34 的取舍翻转 + 留下"未来可加 SettingsDialog 全局默认开关"的钩子说明

### `src/renderer/components/ActivityFeed.tsx` MessageBubble
- import 从 `useGlobalRenderMode` 改成 `readInitialRenderMode`
- `useState(() => readInitialRenderMode())` 初始化本地 mode（每条 bubble mount 时读一次默认）
- 删掉跟随全局 mode 的 `useEffect(() => setMode(globalMode), [globalMode])`
- `toggle` 简化为 `setMode((cur) => cur === 'markdown' ? 'plaintext' : 'markdown')`，不再调 `setGlobalMode`
- 注释明确说明：每条独立、不级联、切过的会话切换 / 重启回到默认

### `README.md`
- 「活动 Tab → 气泡头部 MD/TXT」段落同步：从「偏好走 localStorage 全局生效——切任意一条等于切所有 bubble」改为「**每条消息独立切换、互不级联**……切过的 bubble 卸载（切会话 / 重启）后回到默认」
- 项目结构 `lib/render-mode.ts` 描述同步：`useGlobalRenderMode hook ... CustomEvent 广播` → `readInitialRenderMode：仅在 MessageBubble mount 时读一次 localStorage 作为初始默认；不再广播 / 不再级联`

## 关键场景验证

- 一条消息切到 MD，旁边的消息保持 TXT —— 不再被一起翻
- 同一会话内打开多条 message bubble，互相切换互不影响
- 切到另一个会话再回来 —— 之前切过的 bubble 回到默认（plaintext）；这是有意的简化取舍
- 应用重启 —— 所有 bubble 回到默认；localStorage 里的 `'plaintext'` 值仍存在，但没有 UI 入口改它

## 没动的地方

- 不引入「按 message id 存偏好 map」：CHANGELOG_27 反对的复杂度，本次仍然不做
- 不在 SettingsDialog 加「全局默认渲染模式」开关：用户没有这个需求；如果未来需要再加（写 STORAGE_KEY 即可）
- error 消息 / 空消息不显示按钮、强制 plaintext 的逻辑保持不变
