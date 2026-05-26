# CHANGELOG_137 — 资产库「应用约定」tab 加 codex 视角编辑器

## 概要

资产库 → 应用约定 tab 之前只暴露 claude 侧 (`resources/claude-config/CLAUDE.md` 用户副本编辑器),codex 侧 (`resources/codex-config/CODEX_AGENTS.md`) 后端已有完整路径 (内置 + 用户副本 + 同步到 ~/.codex/AGENTS.md marker 段) 但**前端无对应 UI**,用户改 codex 视角约定只能改源文件 + 重 build。本次补齐对偶 UI:加 adapter switcher (Claude / Codex 二选一) 让用户能在资产库内直接编辑 codex 视角约定。

## 变更内容

### 后端 (主进程)

- `src/main/codex-config/agents-md-installer.ts` 加 4 个公开函数(对偶 sdk-injection.ts 已有的 claude 端):
  - `getActiveCodexAgentsMd()`: 用户副本优先 → 回落内置,返 `{ content, isCustom }`
  - `getBuiltinCodexAgentsMd()`: 永远读内置,给「恢复默认」按钮用
  - `saveUserCodexAgentsMd(content)`: 原子写 (write tmp + rename) + invalidate cache + **立即同步 ~/.codex/AGENTS.md** Agent Deck marker 段(否则用户副本改了但 codex SDK 仍读旧 cache);返写盘后实际读回内容(对偶 ClaudeMd REVIEW_4 M11)
  - `resetUserCodexAgentsMd()`: 删用户副本 + invalidate + 同步段回到内置
- `src/shared/ipc-channels.ts` IpcInvoke enum 加 3 个 entry:`CodexAgentsMdGet / CodexAgentsMdSave / CodexAgentsMdReset`
- `src/main/ipc/settings.ts` 加 3 个 handler 调用上述函数,对偶 ClaudeMd Get/Save/Reset(2MB 上限校验同款)

### 前端

- `src/preload/api/misc.ts` 加 3 个 method:`getCodexAgentsMd / saveCodexAgentsMd / resetCodexAgentsMd`
- 新建 `src/renderer/components/settings/CodexAgentsMdEditor.tsx` (130 行,字面镜像 ClaudeMdEditor.tsx;差异:saved/reset hint 文案明示「已同步到 ~/.codex/AGENTS.md」)
- `src/renderer/components/AssetsLibraryDialog.tsx` ClaudeMdTab 改造:
  - 加 sub-tab switcher (Claude / Codex 二选一,新加 SubTabBtn 组件)
  - 渲染对应 editor (mount/unmount 切换,与主 tab 同款单 editor 模式)
  - sub-tab 切换前用 `confirmDialog` 二次确认 dirty 草稿丢失(对称主 tab 切换的 confirmDiscardClaudeMd 拦截)
  - 子 editor `onDirtyChange` 通过本 tab 内部 `subDirtyRef` forward 给父级(让 dialog 关闭 / 主 tab 切换时仍能拦截当前 sub-editor 的 dirty)

## 不变量

- claude / codex 用户副本独立 (`<userData>/agent-deck-claude.md` vs `<userData>/agent-deck-codex-agents.md`),互不影响
- codex saveUser 后**必须** syncAgentDeckSection 立即写 ~/.codex/AGENTS.md(对偶 claude 走 SDK system prompt cache invalidate + 下次新建会话生效;codex 走静态文件同步,不能漏)
- sub-tab 切换 = 子 editor unmount → 草稿丢失 → 必须 confirm dirty(防误丢)
- toggle `injectAgentDeckCodexAgentsMd` 已存在,本次不动 toggle 逻辑

## verify

- typecheck 0 errors
- pnpm build ✓ main + preload + renderer 全过
- vitest **811 pass | 83 skip 0 fail** (75 files,无新增测试 — 镜像 ClaudeMdEditor 没单测,本次保持对称;后续如加可跨两 editor 抽公用 hook 再补)
- 用户实测:开应用 → 资产库 → 应用约定 tab → 切到 Codex → 改内容 → 保存 → 检查 `~/.codex/AGENTS.md` 段是否更新

## 触发

用户反馈:「资产库的应用约定只有 claude 侧的内容」。后端 SSOT 已分两份 (CHANGELOG_125 P5 codex-handoff-team-alignment plan §D5 切到 codex-config/CODEX_AGENTS.md 独立维护) 但前端 UI 漏暴露 codex 侧。本 changelog 补齐对偶 UI。
