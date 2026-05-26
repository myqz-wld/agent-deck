---
plan_id: "assets-codex-user-and-ui-unify-20260521"
created_at: "2026-05-21T06:49:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/assets-codex-user-and-ui-unify-20260521"
status: "completed"
base_commit: "1fed5d8caca4b39a48841901fa237ab12b8ec862"
base_branch: "main"
final_commit: "7b1b5cbebd307bf876e0ff5a65f235c3e0907e06"
completed_at: "2026-05-21"
---
# 资产页 codex 端 user 自定义补齐 + claude/codex 展示统一优化

## 背景与触发

**用户反馈两条** (2026-05-21)：
1. 「资产页面 skill 和 agent 自定义也只支持 claude」 — 后端 `src/main/user-assets.ts:22-24` 把 user assets root 硬编码成 `~/.claude/agents/` + `~/.claude/skills/<name>/SKILL.md`,没读 codex 端;`AssetMeta.adapter` user 资产强制 `null`(注释把 user 资产说成 SDK `settingSources` 自动加载,但只对 claude 端成立)
2. 「资产页面关于 claude/codex 的展示看看能不能统一优化下」 — 当前两套 paradigm 不统一:
   - 「应用约定」tab(CHANGELOG_137 刚加)用 sub-tab 切换(Claude / Codex 二选一)
   - Skills / Agents tab 用双角标合并(同名跨 adapter SSOT 镜像 SKILL `[claude]` `[codex]` 双 chip)

历史:
- CHANGELOG_125(plan codex-handoff-team-alignment-20260518 §P3) — bundled 资产双 root scan + adapter narrow key
- CHANGELOG_130 — `~/.codex/skills/agent-deck/<X>/SKILL.md` 镜像同步
- CHANGELOG_137 — 资产库「应用约定」tab 加 codex 视角 sub-tab

剩 Skills / Agents tab 用户自定义半边天没补 + UI paradigm 不统一。

## 总目标

- **codex 端 user 自定义补齐**:Skills 支持 `~/.codex/skills/<name>/SKILL.md`(user 自管,与 bundled `~/.codex/skills/agent-deck/<X>/` 同级不冲突);Agents 不支持(codex CLI 文档明确无 user agent 概念)
- **UI paradigm 统一**:三 tab 全 sub-tab 切换(对偶 CHANGELOG_137 应用约定 tab),删 dual-adapter 双角标合并 UI
- **AssetMeta.adapter 强一致**:`'claude-code' | 'codex-cli'`(user 资产也带 adapter 标识,null 删除)
- **不破老 caller**:bundled 资产 spawn_session(adapter, agent_name) registry 路径不变;changelog/INDEX 同步更新

## 不变量

1. **bundled SSOT 隔离**:`syncSkills()` 写 `~/.codex/skills/agent-deck/<X>/`(plugin 命名空间);user codex skill 写 `~/.codex/skills/<name>/`(平级不嵌套)。两路径不撞名(skills-installer.ts:11-12 注释明示)
2. **codex CLI 加载 ~/.codex/skills/<name>/SKILL.md** (spike4 user 实测铁证 + OpenAI 文档承诺,此假设已验证)
3. **codex CLI 不原生支持 user agent** — `~/.codex/agents/` 即使建了 codex CLI 不会自动加载;Agents tab Codex sub-tab user section 显示「不支持」提示文案,不允许 user 在 codex 端建 agent(无 fs 落盘 + 无 spawn 路径 fallback)
4. **AssetEditor 仅 claude agent 可写,codex agent user 模式不存在**:Codex sub-tab 在 Agents tab 内 user section 是 read-only banner,无「+ 新建 Agent」按钮;**IPC 层硬拒不靠前端 disable**(Step 1.5 reviewer-claude R2 MED-2):`saveUserAsset` / `getUserAssetContent` / `deleteUserAsset` / `getUserAssetPath` 入参组合 `kind === 'agent' && adapter === 'codex-cli'` 时立即 reject,防 renderer 走 `window.electronIpc` 兜底通道绕过 UI 直写
5. **同名 user 资产跨 adapter 允许独立两条** (Q3 用户答):scan 各 adapter root 各自扫,renderer 两条独立 AssetMeta;saveUserAsset 不做跨 adapter 同名校验
6. **新建 user 资产 adapter 随当前 sub-tab 锁定** (Q4 用户答):AssetEditor 进入「+ 新建」时 adapter prop 由 sub-tab 当前值传入;编辑模式 adapter 与 name 同款 read-only(不可改;改 adapter = 跨 root mv,本批不实现)
7. **bundled 同名跨 adapter SSOT 镜像资产 (deep-review / hello-from-deck) 不再合并双角标** — 各 sub-tab 独立显一份,删 `dedupBundledByName` / `NonEmptyAssetGroup` / `AdapterBadge` 三件物
8. **dirty 拦截链对偶 CHANGELOG_137 ClaudeMdTab**:子 sub-tab 切换前用 `confirmDialog` 拦截 dirty 草稿;AssetEditor modal 自管 dirty(已存在,不变)
9. **plan 文件位置**:in_progress 短期草稿在 `.claude/plans/<plan-id>.md`(本文件),completed 后由 archive_plan 归档到 `<main-repo>/plans/<plan-id>.md`
10. **changelog 编号自检**:Step 4 写 changelog 前 `ls changelog/CHANGELOG_*.md | sort -V | tail -1` 取真实最大 X,新建 X+1。**不要在本 plan 写死编号** — 计划撰写时仓库可能有新增 changelog(实际本 plan 写时认为最新 137,实测当前已 139,下次新建为 140 但实施时仍要重测)

## 设计决策

### D1. UI 统一为 sub-tab paradigm

**决策**:Skills / Agents / 应用约定 三 tab 全部加 Claude / Codex sub-tab(对偶 CHANGELOG_137 应用约定 tab `ClaudeMdTab` 模式)。

**Why**:用户 RFC Q1 选「全部改为 sub-tab 切换」。两种 paradigm(sub-tab vs 双角标合并)同 dialog 内并存 cognitive overhead 高;统一后用户只需学一种交互。

**How to apply**:
- 抽公共 `AdapterSubTab` 组件(把 CHANGELOG_137 `ClaudeMdTab` `SubTabBtn` + dirty 拦截 boilerplate 抽到 `src/renderer/components/assets/AdapterSubTab.tsx`),让 Skills/Agents/应用约定 三 tab 共用
- adapter sub-tab state 各 tab 独立(切 Skills tab → Codex sub-tab 后再切到 Agents tab,Agents 默认仍 Claude)— 与 CHANGELOG_137 现状一致(每个 tab 内部独立 sub-tab state)

(RFC 第 1 轮 Q1)

### D2. codex user assets 路径镜像 claude 端布局

**决策**:
- skills: `~/.codex/skills/<name>/SKILL.md`(直接落 user 目录,与 bundled `~/.codex/skills/agent-deck/<X>/` 平级)
- agents: 不支持(详 D3)

**Why**:
- spike4 §第 1 步 fs check + §第 2 步 user 实测铁证 codex CLI 自动扫 `~/.codex/skills/<name>/SKILL.md` work(嵌套 1 层 plugin namespace 也支持,user 直接落 root 等于不嵌套同样支持)
- OpenAI 文档承诺 `~/.codex/skills/<X>/SKILL.md` 自动识别 + 在 `/skills` 列出
- skills-installer.ts:11-12 已明示 `agent-deck/` plugin 命名空间「避免与用户手写的 ~/.codex/skills/<X>/ 撞名」 — bundled / user 不撞名为前提

**How to apply**:
- saveUserAsset(adapter:'codex-cli', kind:'skill', name) → 写 `~/.codex/skills/<name>/SKILL.md`
- 不绕中心 dir 镜像同步(syncSkills() 只服务 bundled,user 直写 user dir)
- listUserAssets 双 root scan:claude root + codex root 各自扫 + 合并

(RFC 第 1 轮 Q2 + spike4 实证)

### D3. codex 端 user agent 不支持

**决策**:Agents tab Codex sub-tab user section 显示固定 banner 文案「codex CLI 不原生支持 user 自定义 agent;如需 codex 自定义能力请改建 codex skill,或在 spawn 时直接传完整 prompt(不走 agent_name registry)」。无「+ 新建 Agent」按钮。bundled 部分(reviewer-codex codex-config 端 native body,**仅此 1 条** — claude-config root 是 reviewer-claude / codex-config root 是 reviewer-codex 各自一份不重叠)正常显示。

**Why**:
- OpenAI Codex 官方文档明确「Codex CLI has skills concept only. There is no agents concept for user-level customization of the Codex CLI itself.」(spike4 阶段 WebFetch 实证)
- `~/.codex/agents/<name>.md` 即使建了 codex CLI 不会自动加载(SDK 无 user agent 概念)
- **spawn_session.agent_name 不解析 user dir** — `src/main/agent-deck-mcp/tools/handlers/spawn.ts:107-113` 走 `getBundledAssetContent('agent', name, adapter)` 仅 bundled root scan,user agent 落 ~/.claude/agents/ 不会被该 path resolve(Step 1.5 reviewer-codex MED-A 修订:旧 banner 暗示"通过 spawn_session(agent_name) 调用"会让 caller 撞 `agent body not found` 误导)
- 用户 RFC Q1 第 2 轮答「Agents tab 加 Codex sub-tab,user section 提示不支持」明确选这条路

**How to apply**:
- AssetEditor `adapter='codex-cli'` + `kind='agent'` 组合在 ipc/assets.ts saveUserAsset 入参校验立即 reject(防 renderer 走 `window.electronIpc` 兜底通道绕过 UI 直写)
- AssetsTab `kind='agent' + adapter='codex-cli'` 渲染时 user section 是固定 banner 而非空 list(对偶 InjectionToggleBar 横条样式)
- 不动 spawn_session 路径(bundled-assets registry 仍只查 bundled root,与 D2 同;user agent 与 spawn_session.agent_name registry 是两件事不混淆)

(RFC 第 2 轮 Q1 + spike4 实证 + OpenAI 文档 + Step 1.5 reviewer-codex MED-A 修订)

### D4. 同名 user 资产跨 adapter 允许独立两条

**决策**:不做跨 adapter 同名校验。用户在 claude / codex 各建一个 `my-skill`,fs 上分别落 `~/.claude/skills/my-skill/SKILL.md` 与 `~/.codex/skills/my-skill/SKILL.md`,两条独立 AssetMeta(各 sub-tab 独立显示)。

**Why**:
- claude / codex SKILL.md 内容可能不同(各有各业务逻辑)
- 加跨 adapter 同名校验的成本高(需要 IPC 层做 cross-root 查询),收益低(同名不冲突,fs 路径完全隔离)
- 用户 RFC Q3 选「允许同名,独立两条」

**How to apply**:
- saveUserAsset 仅校验同 adapter 同 kind 同 name 是否已存在(同 root 内 overwrite vs 新建语义)
- listUserAssets:`{ agents: [...], skills: [...] }` 数组内允许同名跨 adapter 两条(adapter 字段区分)
- AssetCard React `key` 沿用 `qualifiedName`:Step 3.4 sub-tab filter 后单 sub-tab 内 user list 是单 adapter 视图,同 root scan name unique,key 用 qualifiedName 天然不撞(不需 `${adapter}:${qualifiedName}` 复合)

(RFC 第 1 轮 Q3 + Step 1.5 reviewer-claude LOW-1 修订)

### D5. 新建 / 编辑 adapter 随 sub-tab 锁定

**决策**:
- **新建模式**(`asset === null`):AssetEditor 接 adapter prop = 当前 sub-tab(Claude sub-tab 内点「+ 新建」 → adapter='claude-code';Codex sub-tab 同理 codex-cli)。新建模式 adapter dropdown 不存在(被 sub-tab 锁定)
- **编辑模式**(`asset !== null`):adapter 从 asset.adapter 读出,与 name 同款 read-only(不可改)。改 adapter = 跨 root mv,本批不实现(避免 confirm dialog + tmp file + 备份恢复 复杂度)
- AssetEditor placeholder 文案 + saved hint 跟着 adapter 切换(claude → `~/.claude/...`;codex → `~/.codex/...`)

**Why**:用户 RFC Q4 选「随当前 sub-tab 锁定 adapter」。编辑模式跨 adapter rename 涉及 mv + 备份恢复 + 备份失败兜底,复杂度比单 adapter rename 高 5x,本批 ROI 低不做。

**How to apply**:
- AssetEditor Props 加 `adapter: 'claude-code' | 'codex-cli'`(必传)
- 保存调 `saveUserAsset({...input, adapter})` 透传
- AssetsTab 调 onNew / onEdit 时一并把当前 sub-tab adapter 透到 AssetEditor

(RFC 第 1 轮 Q4)

### D6. bundled 同名跨 adapter SSOT 镜像资产删除双角标合并

**决策**:删 `src/renderer/components/assets/AssetCard.tsx` 内 `dedupBundledByName` / `NonEmptyAssetGroup` / `AdapterBadge` 三件物。AssetCard 接单条 `AssetMeta`(不再 group),Skills / Agents tab bundled 在各 sub-tab 内各显一份。**bundled agents 现 adapter-specific**(Step 1.5 reviewer-codex R2 MED-A 修订):claude root 仅 `reviewer-claude.md`(`resources/claude-config/agent-deck-plugin/agents/`) / codex root 仅 `reviewer-codex.md`(`resources/codex-config/agent-deck-plugin/agents/`),不存在跨 root 同名 agent;**同名 SSOT 镜像资产仅适用 skills**(`deep-review` / `hello-from-deck` 在 claude/codex root 各 1 份内容相同的 SKILL.md,各 sub-tab 显 1 份)。

**Why**:
- 用户 RFC Q1 第 2 轮答「全删双角标逻辑,sub-tab 各显一份」
- 删除后代码量减约 60 行(dedupBundledByName + AdapterBadge + AssetCard 组件 group 入参逻辑),NonEmptyAssetGroup 类型也删
- AssetCard / ContentViewerModal `state.assets[]` 改成单条;ContentViewerModal `onTabSwitch` 也删(单 adapter 不需切换)

**How to apply**:
- AssetCard props:`assets: NonEmptyAssetGroup` → `asset: AssetMeta`,组件内部去掉 `assets[0]` 取首尾兜底
- AssetsTab 不再调 dedupBundledByName,bundled 数组直接 map
- ContentViewerModal `state` 简化:`{ asset: AssetMeta, content, error }` 单 adapter 模式;onTabSwitch 完全删除(不需切换)
- `state.currentAdapter` / `viewer.assets.find(...)` reveal 路径合并:reveal 用 `viewer.asset` 单点

(RFC 第 1 轮 Q2)

### D7. AssetMeta.adapter user null 改成必填 'claude-code' | 'codex-cli'

**决策**:`AssetMeta.adapter` 类型从 `'claude-code' | 'codex-cli' | null` 改成 `'claude-code' | 'codex-cli'`(user 资产也必带 adapter)。`UserAssetInput` 加 `adapter: 'claude-code' | 'codex-cli'` 必填字段。

**Why**:
- D2 codex user skills 落盘后,user 资产也有 adapter scope(claude or codex),不再是「不属任何 adapter」的 null
- TS 类型层强约束,renderer / IPC / scan / save / delete 全链路都看到 adapter,防 null 兜底分支误用
- buildAgentMeta / buildSkillMeta `adapter: BundledAdapter | null` 简化成 `adapter: 'claude-code' | 'codex-cli'`,所有 null 分支 dead code 删

**How to apply**:
- shared/types/assets.ts:`AssetMeta.adapter` 类型改;jsdoc 改 user 资产说明(加 「'claude-code' / 'codex-cli'」)
- `UserAssetInput` 加 `adapter` 字段 + ipc/assets.ts `parseUserAssetInput` 校验
- main/bundled-assets.ts:删 `__metaBuilders` build*Meta `adapter: BundledAdapter | null` 的 null 分支(老分支只服务 user-assets,新签名 user 也带 adapter)
- main/user-assets.ts:scan 调 build*Meta 透传具体 adapter('claude-code' / 'codex-cli')
- preload / renderer 透传 adapter

### D8. AssetEditor 'model' dropdown 跨 adapter 扩展 — 决策 (a)

**决策**:`MODEL_OPTIONS = ['opus', 'sonnet', 'haiku']` 不变。bundled codex agent .md `model: gpt-5.5` 由 ContentViewerModal readonly 字面显示,不入 AssetEditor form。

**Why** (Step 1.5 deep-review reviewer-claude D8 投票 + reviewer-codex INFO-B 双方独立投 (a),4 条理由):
1. **与 §D3 严格互锁**:§D3 已硬约束「codex 端 user agent 不支持」(reject codex+agent at IPC layer)。codex user agent 路径不存在 → AssetEditor 永不出现 codex agent form → dropdown 不必含 codex model id
2. **RFC Q1 主路径吞 Q2**:Q1 决策(codex 端是否支持 user agent)= "不支持"。Q2(model id dropdown 是否含 codex)基于 Q1 假设"可能支持"时的补充想法,被 Q1 主路径决策吞噬
3. **方案 (b) user 写错风险**:若 dropdown 含 `gpt-5.5` 等 codex model id,Claude sub-tab 用户误选 → 运行时 SDK 跑非 anthropic 模型必报 API error → 用户体验差
4. **bundled codex agent `model: gpt-5.5` 的展示需求另解**:bundled codex agent .md frontmatter 是 fs SSOT,由 `ContentViewerModal` readonly 显示足够;AssetEditor 仅服务 user 资产编辑场景,无需为不可编辑的 bundled codex agent model 字段占 dropdown 槽位;codex SDK 也不接 per-thread model override(spawn.ts:128-136 注释,runtime model 由 ~/.codex/config.toml 决定)

**How to apply**:
- AssetEditor.tsx:29 `MODEL_OPTIONS` 不变(opus / sonnet / haiku)
- bundled codex agent .md `model: gpt-5.5` 是 fs SSOT,从 `getBundledAssetContent` 读取后只在 ContentViewerModal 中显示(不进 AssetEditor form)

## 步骤 checklist

### Phase 1. shared / IPC schema 改造

- [ ] **Step 1.1**: shared/types/assets.ts:`AssetMeta.adapter` 类型从 `'claude-code' | 'codex-cli' | null` 改成 `'claude-code' | 'codex-cli'`,jsdoc 说明 user 也带 adapter;`UserAssetInput` 加 `adapter: 'claude-code' | 'codex-cli'`
- [ ] **Step 1.2**: src/main/ipc/assets.ts:`parseUserAssetInput` 加 `adapter` 校验(必传,枚举);`AssetsGetContent` `AssetsRevealInFolder` source==='user' 时也必传 adapter narrow(替代旧 null 兜底);**`AssetsDeleteUser` handler 加 adapter 第 3 参数**(Step 1.5 reviewer-codex MED-D);新加 `AssetsListBundled` / `AssetsListUser` 不变(仍返 snapshot)
- [ ] **Step 1.3**: src/preload/api 透传 adapter 给 saveUserAsset / deleteUserAsset(三参) / getUserAssetContent / revealUserAsset

### Phase 2. main 后端双 root 改造

- [ ] **Step 2.1**: src/main/user-assets.ts:加 `USER_CODEX_ROOT` / `USER_CODEX_SKILLS_DIR` 常量(**不加** `USER_CODEX_AGENTS_DIR` — Step 1.5 reviewer-claude R2 INFO-1:D3 codex agents 不支持 user 自定义,常量无 caller 是 dead code);`scanUserAgents(adapter)` 显式只扫 claude root(不接 codex 路径,落实不变量 #4 IPC 层硬拒之外的 main 层硬拒);`scanUserSkills(adapter)` 改成接 adapter 参数 → 根据 adapter narrow 到对应 root;`listUserAssets()` 内部 3 次 scan(claude agents / claude skills / codex skills,**不**扫 codex agents)合并出 snapshot。**root-level 失败隔离**(Step 1.5 reviewer-codex LOW-D):每个 scan 函数顶层 try/catch 包裹 `readdirSync(root)`,异常时 console.warn + return [] 不抛错,保证「codex root 不可读 / EACCES / 跨 fs」时 claude user assets 仍能展示(partial snapshot)
- [ ] **Step 2.2**: `getUserAssetContent(kind, name, adapter)` `getUserAssetPath(kind, name, adapter)` 加 adapter 参数派发(Claude:`~/.claude/...` / Codex:`~/.codex/...`);**reject codex+agent 组合**(D3 不变量 4 — codex CLI 不原生支持,即使有 fs 落盘也走不通)— 调 §改动文件清单 `validateAdapterKind(adapter, kind)` helper 一处实现(Step 1.5 reviewer-claude LOW-3)
- [ ] **Step 2.3**: `saveUserAsset(input)` 用 input.adapter 派发 targetPath;**reject codex+agent 组合**(调 `validateAdapterKind` helper);原子写流程同款(write tmp + rename + finally 删 tmp)
- [ ] **Step 2.4**: `deleteUserAsset(kind, name, adapter)` adapter 派发删除;codex+agent 组合也 reject(防 caller 误调,调 `validateAdapterKind` helper)
- [ ] **Step 2.5**: src/main/bundled-assets.ts:`__metaBuilders.buildAgentMeta` / `buildSkillMeta` `adapter` 参数从 `BundledAdapter | null` 改成 `'claude-code' | 'codex-cli'` 必填;jsdoc 改;qualifiedName 拼装 `bundled` 分支保留,user 也用 `<name>` 不变
- [ ] **Step 2.6**: 单测覆盖:user-assets.test.ts 加双 root scan / save / delete / codex+agent reject 用例

### Phase 3. renderer UI 重构

- [ ] **Step 3.1**: 抽 `src/renderer/components/assets/AdapterSubTab.tsx`(从 CHANGELOG_137 ClaudeMdTab `SubTabBtn` + dirty 拦截 boilerplate 抽公共组件),让 Skills/Agents/应用约定 三 tab 共用。**dirty 拦截 prop 设 optional**(Step 1.5 reviewer-claude R2 MED-3):签名 `onSwitch?: (next: 'claude-code' | 'codex-cli') => Promise<boolean>`(返 false 拦截切换,返 true / undefined 不拦);Skills/Agents tab 不传(sub-tab 切换无 dirty,filter 视图变更不丢草稿),应用约定 tab(ClaudeMdTab)传 dirty 检查 callback(子 editor 持有未保存草稿时弹 confirmDialog)
- [ ] **Step 3.2**: AssetCard.tsx 删除 `dedupBundledByName` / `NonEmptyAssetGroup` / `AdapterBadge` 三件物;AssetCard props 改成 `asset: AssetMeta`(单条);组件内部去 `assets[0]` 兜底
- [ ] **Step 3.3**: ContentViewerModal `state` 改成 `{ asset: AssetMeta, content, error }` 单 adapter 模式;**显式同步重构**(Step 1.5 reviewer-claude R2 LOW-3):删 `ContentViewerState.assets: NonEmptyAssetGroup` → 改 `asset: AssetMeta` 单条;删 `currentAdapter` / `onTabSwitch` props;reveal 改用 `viewer.asset`;modal 内不再渲染 dual-adapter tab 切换器
- [ ] **Step 3.4**: AssetsLibraryDialog Skills/Agents tab 加 sub-tab 切换(用 AdapterSubTab 公共组件);AssetsTab 改成接 `adapter` prop(由 sub-tab 透),内部 filter `bundled.filter(a => a.adapter === adapter)` + `user.filter(a => a.adapter === adapter)` 切;Codex sub-tab Agents tab user section 渲染固定 banner(不渲染「+ 新建」按钮)
- [ ] **Step 3.5**: AssetEditor.tsx 加 `adapter: 'claude-code' | 'codex-cli'` props(必传);placeholder + saved/error hint 文案 sub-tab 切换;getAssetContent 调用透传 adapter(不再 hardcode null);新建模式调用 saveUserAsset 透传 adapter;**`remove()` 调用必须三参 `deleteUserAsset(asset.kind, asset.name, asset.adapter)`**(Step 1.5 reviewer-codex MED-D — 同名跨 adapter 独立资产不变量 #5,只删当前 adapter root 不漂跨 root);**modal header 加 adapter chip**(Step 1.5 reviewer-claude R2 LOW-2):title 旁显示 `[claude]` / `[codex]` 二色 chip 与 ContentViewerModal 对齐,让用户编辑时一眼看出资产 adapter scope;**codex skill 删除 toast**(Step 1.5 reviewer-claude R2 MED-4):`remove()` 成功路径中 `if (asset.kind === 'skill' && asset.adapter === 'codex-cli')` 触发 toast 文案「已删除该 skill;运行中的 codex CLI 需重启(`pkill -f codex` 后重启)才看到生效」(对应 §已知踩坑 §9 in-memory cache 残留;`adapter === 'claude-code'` 路径不需 toast,claude SDK 加载 user skills 实时不缓存)
- [ ] **Step 3.6**: viewer state seq guard 链路对偶现状(单 adapter 不变;onTabSwitch 删后 seq guard 仍要跑 closeViewer / openViewer)

### Phase 4. typecheck + 测试 + 验证

- [ ] **Step 4.1**: `pnpm typecheck` 0 errors
- [ ] **Step 4.2**: `pnpm exec vitest run`(全部),0 fail;新加双 root scan 单测在 user-assets 覆盖率上表;现有 60+ 资产页测试调整(AssetCard NonEmptyAssetGroup 删除影响)
- [ ] **Step 4.3**: `pnpm build` main + preload + renderer 全过
- [ ] **Step 4.4**: 用户实测 codex skill 全周期(dev mode):
  - **前置**: 关闭所有运行中的 codex CLI instance(`pkill -f codex` 或 quit codex CLI;Step 1.5 reviewer-claude R2 LOW-4 + reviewer-codex MED-E 共识:codex CLI 启动时只扫一次 `~/.codex/skills/` 缓存到 in-memory,后续新建 skill 必须重启 codex 才能看到)
  - **(a) 新建**:打开应用 → 资产库 → Skills tab → Codex sub-tab → 「+ 新建」建一个 codex skill `test-codex-skill` → 检查 `~/.codex/skills/test-codex-skill/SKILL.md` 落盘 + **新开** codex CLI interactive `/skills` 能列出 `test-codex-skill`(若不显示走 §已知踩坑 §8 fallback 路径)
  - **(b) 删除**:在资产库内删 `test-codex-skill` → 检查 `~/.codex/skills/test-codex-skill/` 目录消失 + **检查 UI hint toast 提示**「已删除该 skill;运行中的 codex CLI 需重启」(§已知踩坑 §9 + Step 3.5 toast 触发条件) + **新开** codex CLI 验 `/skills` 不再含 `test-codex-skill`
  - **(c) 重建同名**:同名再建一次 `test-codex-skill`(内容稍改)→ 检查 fs 落盘 + **新开** codex CLI `/skills` 含新版本(覆盖 in-memory cache 边界,Step 1.5 reviewer-codex MED-E)
- [ ] **Step 4.5**: 用户实测(dev mode):Agents tab → Codex sub-tab → 看到「不支持」banner + 看到 bundled `reviewer-codex` 仅 1 条(codex-config root native body);切到 Claude sub-tab → 看到 bundled `reviewer-claude` 仅 1 条(claude-config root native body)。**注**: `reviewer-claude.md` 仅在 `resources/claude-config/agent-deck-plugin/agents/`、`reviewer-codex.md` 仅在 `resources/codex-config/agent-deck-plugin/agents/`(各 root 一份不重叠,Step 1.5 reviewer-codex MED-B 实证)
- [ ] **Step 4.6**: 用户实测 renderer 主链路(dev mode,Step 1.5 reviewer-codex R2 MED-C — 不变量 #6/#7/#8 UI 重构核心需手工验收):
  - **(a) sub-tab filter 视图**:Skills/Agents tab 切 Claude sub-tab → list 仅 adapter='claude-code' 资产;切 Codex sub-tab → list 仅 adapter='codex-cli' 资产(filter 派发正确,无重复展示)
  - **(b) Codex Agents banner**:Agents tab → Codex sub-tab → user section 显「不支持」banner 文字 + **无「+ 新建 Agent」按钮**(D3 对应)
  - **(c) AssetEditor adapter 锁定**:Claude sub-tab 内点「+ 新建」 → AssetEditor mount 时 adapter='claude-code',header chip 显 [claude],保存调 saveUserAsset(adapter='claude-code');Codex sub-tab 同理但 chip 显 [codex];编辑模式 adapter 不可改(read-only,与 name 同款)
  - **(d) AssetEditor remove 三参**:claude/codex 同名 skill 各建 1 份 → Codex sub-tab 删除 `foo` → claude `~/.claude/skills/foo/` 仍在(只删 codex root)
  - **(e) 应用约定 sub-tab dirty confirm**:应用约定 tab → Claude editor 改一行不保存 → 切 Codex sub-tab → 弹 confirm dialog 拦截(沿用 CHANGELOG_137);Skills/Agents tab sub-tab 切换不弹 confirm(Step 3.1 onSwitch optional 不传)
  - **(f) ContentViewerModal 单 adapter**:bundled deep-review skill(SSOT 镜像)在 Claude / Codex sub-tab 各点查看 → modal 直接渲染对应 adapter 内容,无 dual-adapter tab 切换器

## 当前进度

Step 0/0.5 RFC + spike 收敛 → Step 1 plan 写完 → **Step 1.5 R1+R1.5+R2 deep-review 完成**(reviewer-claude × 2 轮 + reviewer-codex × 2 轮 + R1.5 follow-up,共 21 条 fix 已 inline 落地;两 reviewer R2 都说 0 HIGH / plan ✅ 可合 / 实施前落剩余 MED 即可开工)。Step 2 EnterWorktree 待 user confirm 后进。

## 下一会话第一步

按 plan 步骤 checklist 推进。如本会话写到一半就接力新会话:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/assets-codex-user-and-ui-unify-20260521.md`
2. 看 frontmatter `worktree_path` 与 `base_commit`(`1fed5d8caca4b39a48841901fa237ab12b8ec862`)
3. **先检查 worktree 是否已存在**(Step 1.5 reviewer-codex R2 MED-B 修订):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree list --porcelain | grep -A 1 'worktree.*assets-codex-user-and-ui-unify-20260521' || echo 'WORKTREE_MISSING'
   ```
4. 进 worktree(adapter 分流;按 step 3 输出选 fresh-create vs reuse-existing 分支):
   - **claude-code adapter**(任意状态):
     - **WORKTREE_MISSING**: 走 user CLAUDE.md §Step 2 EnterWorktree CLI stale base bug 主路径 (b) — 先 Bash 显式建 worktree(必须含 base_commit `<commit-ish>`,不能省略否则用 origin/main fallback 撞 stale base bug):
       ```bash
       git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-assets-codex-user-and-ui-unify-20260521 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/assets-codex-user-and-ui-unify-20260521 1fed5d8caca4b39a48841901fa237ab12b8ec862
       ```
       然后 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/assets-codex-user-and-ui-unify-20260521")`
     - **worktree EXISTS**(接力场景): 直接 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/assets-codex-user-and-ui-unify-20260521")`(不能再调 `git worktree add` 撞 path/branch already exists)
     - 进入后立即自检 HEAD: `git -C <wt> rev-parse HEAD` 应等 `1fed5d8caca4b39a48841901fa237ab12b8ec862`(WORKTREE_MISSING fresh create 必等 / EXISTS 状态可能比 base 推进过,确认是该 worktree-<plan-id> 分支即可不要 reset 历史)。仅 fresh + HEAD 不等 → `git -C <wt> reset --hard 1fed5d8caca4b39a48841901fa237ab12b8ec862`(destructive,worktree 是空仍未改动可放心)
   - **codex-cli adapter**(任意状态):
     - **WORKTREE_MISSING**: 走 codex 端 cold-start 协议(详 `resources/codex-config/CODEX_AGENTS.md §enter_worktree` 节) — `mcp__agent-deck__enter_worktree({plan_id:'assets-codex-user-and-ui-unify-20260521', base_commit:'1fed5d8caca4b39a48841901fa237ab12b8ec862'})`,handler 内部 `git worktree add -b <branch> <path> <base_commit>` 显式带 base_commit 避撞 EnterWorktree CLI stale base bug + 自动写 sessionRepo.cwd_release_marker 兜底 archive_plan 4 态预检
     - **worktree EXISTS**: **不能调** `mcp__agent-deck__enter_worktree`(handler 显式 reject `worktree path already exists`,见 src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts:261-265)。改为所有 shell 命令显式 `git -C <worktree-path> ...` + 归档时 caller 把 worktree_path 显式传给 `archive_plan({worktree_path: ...})`
5. **base_commit ff-merge 风险**(Step 1.5 reviewer-claude R2 INFO-2):base_commit `1fed5d8caca4b39a48841901fa237ab12b8ec862`(2026-05-21) 截至 plan 写时与主线 HEAD `30574d5...`(差 ~5 commits)。实施期间避免主线高频推进 / 频繁 sync base;若 archive_plan ff-merge 撞 conflict → worktree branch rebase main HEAD(详 user CLAUDE.md §Step 4 完成节,base_branch 可能需切换重 ff)
6. 按 Phase 1 → Phase 4 顺序推进;每个 Step 完打勾 + commit message 引用 step 编号;Step 1.5 deep-review HIGH 必修不能跳

## 已知踩坑

1. **scan codex user skills 与 syncSkills() bundled 同步路径不撞名** — `~/.codex/skills/agent-deck/<X>/`(bundled) vs `~/.codex/skills/<name>/`(user 平级);scanUserSkills(codex) 显式 `if (entry === 'agent-deck') continue` skip 是 **defense in depth**(防御未来 codex bundled 路径策略变化时 leak);**实际工作机制**:scanUserSkills 只检 `<entry>/SKILL.md` 一层,bundled 落 `agent-deck/<X>/SKILL.md` 嵌套两层不会被识别 — 现有扫描天然过滤(Step 1.5 reviewer-claude INFO-1 + reviewer-codex INFO-A 修订:旧文字"否则 user 列表会出现 deep-review / hello-from-deck 占位"是错误断言)
2. **codex CLI 自带 `~/.codex/skills/.system/` 系统目录** — `isSafeName(entry)` 已 reject `.` 开头(ASSET_NAME_REGEX 首字符 `[a-z0-9]`),scan 时自动跳过,无需手工 skip
3. **AssetMeta.adapter null → 必填的迁移**:任何老缓存 / 持久化资产数据若有 adapter=null 字段会 TS 编译期被 narrow 拒;但应用没把 AssetMeta 持久化到 SQLite(只是 IPC 当场返,renderer state local),所以无 migration 风险
4. **dirty 拦截链复杂化**:三 tab 主切换(`guardedSwitchTab`)+ Skills/Agents tab sub-tab 切换 + 应用约定 sub-tab 切换 + AssetEditor modal 关闭 = 4 层 dirty 拦截。需小心 closeInFlightRef 单飞锁不被多层切换路径并发突破。**Step 3.1 AdapterSubTab onSwitch optional**(Step 1.5 reviewer-claude R2 MED-3):Skills/Agents 不传(无 dirty),应用约定传(子 editor dirty)
5. **AssetCard 删 dedupBundledByName 后老 bundled list `[claude]` `[codex]` 双角标资产**:`reviewer-claude.md` 仅在 claude-config root,`reviewer-codex.md` 仅在 codex-config root(name 不同)— 原 dedup 不会合并这两个,改造后影响 0;`deep-review` / `hello-from-deck`(SSOT 镜像同名同 kind)以前合并 1 条,新版各 sub-tab 显 1 条,name 一致 body 一致(SSOT),无歧义(Step 1.5 reviewer-codex 独立 grep 验证两 reviewer agent .md 文件分布属实)
6. **deleteUserAsset 删 codex skill 子目录** 可能撞 codex 自管的「同名」目录(冲突极少,name slug `[a-z0-9-]+` 不撞 codex `.system` `agent-deck` 命名空间);保留现有 lstatSync symlink reject 兜底
7. **user 平级 codex skill path 未独立 spike** — spike4 实测仅覆盖 `~/.codex/skills/agent-deck/<X>/SKILL.md`(嵌套 2 层 bundled 路径),§D2 设计的 user 平级 `~/.codex/skills/<name>/SKILL.md` 仅基于 OpenAI 文档承诺「Codex detects newly installed skills automatically」泛化(Step 1.5 reviewer-claude MED-1)。**风险**:若 codex CLI 实测平级 path 不被识别 → §D2 设计崩塌,fallback 走 `~/.codex/skills/user/<name>/`(显式 plugin scope)。**Step 4.4 用户实测必须验证此点**:建一个 `test-codex-skill` user skill → codex CLI interactive `/skills` 输出 list 是否含此 skill;不含则触发 fallback 路径
8. **删 user codex skill 后 codex CLI in-memory cache 残留** — OpenAI 文档原文「if one doesn't appear, restart Codex」暗示 codex CLI 维护 in-memory skills cache(Step 1.5 reviewer-claude MED-2,*未验证*)。**UI 层加固**:Step 3.5 AssetEditor `remove()` 成功路径 + `if (asset.kind === 'skill' && asset.adapter === 'codex-cli')` 触发 toast 文案「已删除该 skill;运行中的 codex CLI 需重启(`pkill -f codex` 后重启)才看到生效」;不阻塞主流程,只信息提示;claude skill 路径不需 toast(claude SDK 实时加载 user skills 不缓存)
9. **base_commit 长期 in_progress ff-merge 风险**(Step 1.5 reviewer-claude R2 INFO-2):frontmatter `base_commit: 1fed5d8...` 与主线 HEAD 漂移过大 → archive_plan ff-merge 撞 conflict。实施期间避免主线高频推进;若漂移超过 ~10 commits 撞 conflict → worktree branch rebase main HEAD(详 user CLAUDE.md §Step 4 完成节 base_branch 切换重 ff)

## 改动文件清单(预估)

新建:
- `src/renderer/components/assets/AdapterSubTab.tsx`(公共 sub-tab 组件)

修改:
- `src/shared/types/assets.ts`(AssetMeta.adapter 类型 + UserAssetInput 加 adapter)
- `src/main/user-assets.ts`(双 root scan / save / delete / codex+agent reject;**抽 `validateAdapterKind(adapter, kind): { ok: boolean; reason?: string }` helper** Step 2.2-2.4 共调,Step 1.5 reviewer-claude LOW-3 修订;**root-level try/catch fallback** 让 readdirSync 异常时 console.warn + 返 [] 不抛错,Step 1.5 reviewer-codex LOW-D)
- `src/main/bundled-assets.ts`(buildAgentMeta / buildSkillMeta 签名收紧)
- `src/main/ipc/assets.ts`(parseUserAssetInput / parseSource 校验链 + AssetsDeleteUser handler 加 adapter 第 3 参数)
- `src/preload/api/misc.ts`(透传 adapter,deleteUserAsset 改三参)
- `src/renderer/components/AssetsLibraryDialog.tsx`(Skills/Agents tab sub-tab 化)
- `src/renderer/components/assets/AssetEditor.tsx`(adapter prop + placeholder 切换 + remove() 三参 deleteUserAsset)
- `src/renderer/components/assets/AssetCard.tsx`(删 dedup / NonEmptyAssetGroup / AdapterBadge,改单条)
- `src/renderer/components/assets/ContentViewerModal.tsx`(单 adapter 模式)

测试:
- `src/main/__tests__/user-assets.test.ts`(新建/调整,覆盖):
  - 双 root scan(claude agents / claude skills / codex skills 各自路径);codex+agent 组合 reject(D3 不变量 4)
  - `scanUserAgents` 显式只扫 claude root(传 'codex-cli' 应直接返 [] 不应该扫 ~/.codex/agents/,Step 1.5 reviewer-claude R2 INFO-1)
  - 同名跨 adapter user skill 独立两条(`~/.claude/skills/foo/SKILL.md` + `~/.codex/skills/foo/SKILL.md` listUserAssets 返 2 条 AssetMeta,adapter 字段区分,Step 1.5 reviewer-claude MED-3)
  - scanUserSkills(codex root) skip `agent-deck/` 子目录(防御性,Step 1.5 reviewer-claude INFO-1 修订:目的不是防"出现 deep-review 占位"假断言,而是防未来若递归 scan 时误收 bundled)
  - **同名跨 adapter user skill 删除只删当前 adapter root**(Step 1.5 reviewer-codex MED-D):建 claude+codex 两份同名 → deleteUserAsset(kind, name, 'codex-cli') → assert claude 仍在 / codex 已删
  - **root-level partial snapshot fallback**(Step 1.5 reviewer-codex LOW-D):mock readdirSync(codex root) throw EACCES → assert listUserAssets 返 claude root assets + codex empty + console.warn(不抛错)
- **新建** `src/main/ipc/__tests__/assets.test.ts`(Step 1.5 reviewer-codex MED-C — 现有 ipc/__tests__/ 没 assets.test.ts,测试盲区必补):
  - `AssetsSaveUser` 缺 adapter / 非法 adapter 字符串值 → reject
  - `AssetsSaveUser` codex+agent 组合 → reject(对偶 main user-assets reject;**IPC 层硬拒**,不靠前端 disable,Step 1.5 reviewer-claude R2 MED-2 落实不变量 #4)
  - `AssetsGetContent` source='user' 时 adapter 必传(不传 → reject;含非法值 → reject;codex+agent → reject)
  - `AssetsRevealInFolder` source='user' 时 adapter 必传(同款,codex+agent → reject)
  - **`AssetsDeleteUser` 三参签名**(Step 1.5 reviewer-codex MED-D):缺 adapter / 非法 adapter / codex+agent reject 各 1 case
- **新建** `src/main/codex-config/__tests__/skills-installer.test.ts`(Step 1.5 reviewer-codex R2 LOW-A — settings toggle 与 user codex skill 共存回归):
  - 建 `~/.codex/skills/agent-deck/deep-review/SKILL.md`(bundled mirror) + sibling `~/.codex/skills/user-skill/SKILL.md`(user 平级) → 关闭 `injectAgentDeckCodexSkills` toggle 触发 `syncSkills()` → assert `agent-deck/` 整目录被删 + `user-skill/` 仍在(skills-installer.ts:71-82 行为 regression)
  - 重新打开 toggle → bundled `agent-deck/deep-review/` 重新出现 + `user-skill/` 不动
- **手工验收**:Step 4.6 renderer 主链路实测覆盖不变量 #6/#7/#8 sub-tab filter / Codex Agents banner / AssetEditor adapter 锁定 / remove 三参 / dirty confirm / ContentViewerModal 单 adapter(Step 1.5 reviewer-codex R2 MED-C)

文档:
- `changelog/CHANGELOG_<X+1>.md`(新建,X = 实施时 `ls changelog/CHANGELOG_*.md | sort -V | tail -1` 取最大;**不要写死编号**,plan 撰写期间仓库可能新增 changelog)
- `changelog/INDEX.md`(append 行)
