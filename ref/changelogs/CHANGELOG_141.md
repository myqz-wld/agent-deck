# CHANGELOG_141 — 资产页 codex 端 user 自定义补齐 + claude/codex 展示统一优化

## 概要

资产库 Skills/Agents tab user 自定义之前只支持 claude(`~/.claude/{agents,skills}/`),codex 端无对应 UI;且应用约定 tab 用 sub-tab 切换 / Skills/Agents tab 用双角标合并是两套不一致 paradigm。本次三 tab 全部统一为 sub-tab 切换(对偶 CHANGELOG_137 应用约定 tab),同时补齐 codex user skill 落 `~/.codex/skills/<name>/SKILL.md`(spike4 + OpenAI 文档实证)。

详 plan [`plans/assets-codex-user-and-ui-unify-20260521.md`](../plans/assets-codex-user-and-ui-unify-20260521.md)(D1-D7 七项设计决策 + 不变量 #1-#10 + 已知踩坑 §1-§9 + Phase 1-4 步骤 checklist)。

## 变更内容

### 类型 / IPC schema (Phase 1)

- `src/shared/types/assets.ts`: `AssetMeta.adapter` 类型从 `'claude-code' | 'codex-cli' | null` 收紧成 `'claude-code' | 'codex-cli'`(null 完全删除,user 资产也按 adapter 派发);`UserAssetInput` 加 `adapter: 'claude-code' | 'codex-cli'` 必填字段;新加 `validateAdapterKind(adapter, kind)` helper(跨进程共享,IPC + main 双层硬拒 codex+agent 组合,plan §不变量 #4)
- `src/main/ipc/assets.ts`: `parseAdapterRequired` 替代旧 `parseBundledAdapterOrNull`(user 也必传 adapter);`parseUserAssetInput` 加 adapter 校验 + codex+agent reject;`AssetsDeleteUser` handler 加 adapter 第 3 参数;`AssetsGetContent` / `AssetsRevealInFolder` source==='user' 时也必传 adapter narrow
- `src/preload/api/misc.ts`: `getAssetContent` / `revealAssetInFolder` 第 4 参数 adapter 类型收紧(删 null);`deleteUserAsset` 加 adapter 第 3 参数;`saveUserAsset` UserAssetInput 含 adapter 字段

### main 后端双 root 改造 (Phase 2)

- `src/main/user-assets.ts`: 加 `USER_CODEX_ROOT` / `USER_CODEX_SKILLS_DIR` 常量(**不加** `USER_CODEX_AGENTS_DIR` — codex CLI 无 user agent 概念);`scanUserAgents(adapter)` codex 直接返 [];`scanUserSkills(adapter)` 按 adapter narrow root,**codex root skip `agent-deck/` 子目录**(defense in depth,plan §不变量 #1);所有 scan 函数顶层 try/catch 包裹 readdirSync,异常 console.warn + 返 [] 让 partial snapshot 不被一个 root 失败拖垮(reviewer-codex LOW-D);`saveUserAsset` / `getUserAssetContent` / `getUserAssetPath` / `deleteUserAsset` 所有签名加 adapter,内部调 `validateAdapterKind` 拒 codex+agent
- `src/main/bundled-assets.ts`: `__metaBuilders.buildAgentMeta` / `buildSkillMeta` `adapter: BundledAdapter | null` 收紧成 `'claude-code' | 'codex-cli'` 必填;`compareAdapterThenName` 删 null defensive narrow

### renderer UI 统一改造 (Phase 3)

- 新建 `src/renderer/components/assets/AdapterSubTab.tsx` 公共组件(Skills/Agents/应用约定 三 tab 共用);`onSwitch` prop 设 optional 让 Skills/Agents 不传(无 dirty)/ 应用约定传(子 editor dirty 拦截)
- `src/renderer/components/assets/AssetCard.tsx`: 删 `dedupBundledByName` / `NonEmptyAssetGroup` / `AdapterBadge` 三件物;AssetCard 改单条 AssetMeta(各 sub-tab 单 adapter 视图,同名 SSOT 镜像 SKILL 在 claude/codex sub-tab 各显 1 份)
- `src/renderer/components/assets/ContentViewerModal.tsx`: `ContentViewerState.assets: NonEmptyAssetGroup` 改 `asset: AssetMeta`;删 `currentAdapter` / `onTabSwitch` props 与 dual-adapter tab 切换器 UI
- `src/renderer/components/assets/AssetEditor.tsx`: 加 `adapter: 'claude-code' | 'codex-cli'` 必传 prop;header 加 adapter chip([claude] 蓝 / [codex] 紫,与 ContentViewerModal 对齐);placeholder 路径文案随 adapter 切换;`remove()` 调用 `deleteUserAsset(kind, name, asset.adapter)` 三参(plan §不变量 #5 同名跨 adapter 删除只删当前 root);codex skill 删除 confirmDialog detail 加「需重启 codex CLI」hint(对应 §已知踩坑 §8 in-memory cache 残留)
- `src/renderer/components/AssetsLibraryDialog.tsx`: Skills/Agents tab 加 sub-tab(用 AdapterSubTab 公共组件);AssetsTab 接 adapter prop filter bundled / user;**Codex sub-tab Agents tab user section 显「不支持」banner**(对应 plan §D3 不变量 #4);`openViewer` 改单 asset 模式;invoke AssetEditor 时透传当前 sub-tab adapter;TabBtn / SubTabBtn 内部组件迁出独立文件后主文件 547 → 453 行(LOC 防线 ✅)

### 不动文件保护清单

无新增不动清单;Phase 2 测试补全(`user-assets.test.ts` 加 case / 新建 `ipc/__tests__/assets.test.ts` / 新建 `codex-config/__tests__/skills-installer.test.ts`)按 user 决策推迟 — plan reviewer 双方 R2 显式说 0 HIGH 0 真 MED plan ✅ 可合,user 实测验收也按 user 决策跳过,改造主体已通过 typecheck + 资产相关 vitest + pnpm build 三道闸门。

## verify

- `pnpm typecheck` 0 errors
- `pnpm exec vitest run src/main/__tests__/bundled-assets-multi-root.test.ts` 4/4 pass(资产模块单测全过,验证 buildAgentMeta / buildSkillMeta adapter 收紧不破坏)
- `pnpm build` ok(main 633KB / preload 22KB / renderer 1.4MB,build warning 是 pre-existing agent-deck-team-repo dynamic import 不影响)
- pre-existing test 失败(archive-plan / task-manager / manager-ingest 等 11 case)与本改造无关

## 触发

用户反馈两条:
1. 「资产页面 skill 和 agent 自定义也只支持 claude」
2. 「资产页面关于 claude/codex 的展示看看能不能统一优化下」

走 user CLAUDE.md §复杂 plan 流程:Step 0 RFC × 2 轮 (4+2 题对齐 design 大方向) → Step 0.5 spike(spike4 实证复用 + OpenAI 文档实证 codex 无 user agent) → Step 1 plan(.claude/plans/) → Step 1.5 deep-review(reviewer-claude × 2 + reviewer-codex × 2 spawn,R1 14 fix + R2 7 fix 共 21 条 inline) → Step 2 user confirm + EnterWorktree → Phase 1-3 实施 + Phase 4 verify(typecheck + build + 资产 vitest) → Step 4 archive_plan 收口。
