---
review_id: 55
reviewed_at: 2026-05-25
expired: false
---

# REVIEW_55: 长生命周期 prompt 资产 §提示词资产维护 7 条约束全量对抗 review × 3 轮 fix-review 循环

## 触发场景

用户主动要求按 user CLAUDE.md §提示词资产维护 节(7 条约束 + 7 步自检)对全量 prompt 资产做对抗 review。资产覆盖 user 全局 / 应用打包 / plugin agent body / SKILL / 外部 CLI 模板,横跨 user scope 与项目 repo,首次系统性按 5+2 条约束全审。

## scope

9 个 unique 文件 1570 LOC(含 2 对镜像 + 2 对对偶):

| # | 文件 | LOC | 类别 |
|---|---|---|---|
| 1 | `~/.claude/CLAUDE.md` | 494 | user 全局约定 |
| 2 | `resources/claude-config/CLAUDE.md` | 205 | 应用打包注入 SDK system prompt |
| 3 | `resources/claude-config/README.md` | 38 | dev 维护说明 |
| 4 | `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` | 139 | plugin agent body(对偶 5) |
| 5 | `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` | 140 | plugin agent body(对偶 4) |
| 6 | `resources/claude-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md` | 18 | plugin SKILL(镜像 codex-config) |
| 7 | `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md` | 207 | plugin SKILL(镜像 codex-config) |
| 8 | `~/.claude/templates/reviewer-claude.sh.tmpl` | 68 | 外部 CLI 模板(对偶 9) |
| 9 | `~/.claude/templates/reviewer-codex.sh.tmpl` | 36 | 外部 CLI 模板(对偶 8) |

## 方法

**3 轮 fix-review 循环 / 每轮双 Bash 并发起异构外部 CLI**(user CLAUDE.md §决策对抗 主路径):

- **reviewer-claude** = `~/.claude/templates/reviewer-claude.sh.tmpl`(claude --model opus --add-dir ~/.claude --allowedTools 只读白名单 --disallowedTools 'Edit,Write,...,ExitPlanMode')
- **reviewer-codex** = `~/.claude/templates/reviewer-codex.sh.tmpl`(codex exec --sandbox read-only -c model_reasoning_effort=xhigh)
- 两个外部 CLI 进程独立(互不知道对方存在),fresh per turn 不带跨轮 mental model
- 每轮主 agent 收两份独立结论后做三态裁决(✅ / ❌ / ❓)

**focus**(每轮 prompt 内强制):

约束 1 信息密度 / 约束 2 当前事实(禁兼容/未来/deprecated)/ 约束 3 可执行性(禁建议/可以/最好)/ 约束 4 范围与失败兜底显式 / 约束 5 示例克制 / 约束 6 plugin self-contained / 约束 7 对偶/镜像/模板同步。

## 三态裁决(累计 3 轮)

### ✅ 真问题(共 23 条 fix)

#### Round 1 — 11 条(MED 6 + LOW 5)

| Finding | 文件 | 违反约束 | 严重度 | 双方共提 / 单方现场验证 |
|---|---|---|---|---|
| A1 | `claude-config/CLAUDE.md:193` 「保最大兼容性,推荐」 | 2 | LOW | 双方共提 |
| A2 | `reviewer-{claude,codex}.sh.tmpl:20/10` 「fallback /tmp 兼容非 SDK 场景」 | 2 | LOW | 双方共提 |
| A3 | `reviewer-{claude,codex}.md:37/38` fresh session warn 「建议 lead 走 shutdown_session」 | 3 | LOW | codex 独有,对偶对照铁证 |
| A4 | `claude-config/CLAUDE.md:109` NO MSG ANCHOR 「建议 lead 通过 send_message」 | 3 | MED | 双方共提 |
| B1 | `reviewer-{claude,codex}.md:79/80` 引用 「应用 CLAUDE.md / CODEX_AGENTS.md §Finding 输出契约(如有)」错指 | 2/6 | MED | 双方共提(codex grep 铁证节实际在 user CLAUDE.md:71) |
| B2 | `reviewer-claude.md:1-15` 缺 orientation block(对偶 reviewer-codex.md L7-10 显式 inline) | 6/7 | MED | claude 独有,diff 验证铁证 |
| B3 | `reviewer-claude.sh.tmpl:43-59` prompt heredoc 约束节缺「用中文输出 / 跑测试」对偶项 | 6/7 | MED | codex 独有,diff 验证铁证 |
| B4 | `reviewer-codex.sh.tmpl:15` prompt 「Codex gpt-5.5 xhigh」写死 model 名但命令未固定 | 2/4/7 | MED | codex 独有,diff 验证铁证 |
| B5 | `claude-config/README.md:38` 「不复述协议细节」与现状反 | 2/4 | MED | codex 独有,reviewer body 已 inline 大量协议细节铁证 |
| C1 | `~/.claude/CLAUDE.md:346` 「`mcp__tasks__*`」旧 namespace(已合并到 `mcp__agent-deck__task_*`) | 2/7 | MED | codex 独有(降级,user-scope SSOT 描述性引用) |
| C2 | `~/.claude/CLAUDE.md:470` 标题「### 应用 plugin 资产专属约束」适用范围不准(约束 7 实际通用) | 4/7 | MED | codex 独有 |
| D1 | `hello-from-deck/SKILL.md:15` 缺验证标准 + 失败兜底 | 4/6 | LOW | codex 独有 |

#### Round 2 — 8 条(MED 5 + LOW 3,Round 1 reviewer 漏报 + B3 fix 引入)

| Finding | 文件 | 严重度 | 来源 |
|---|---|---|---|
| MED-1 | `claude-config/CLAUDE.md:180` hand_off_session 调用签名漏 `team_task_policy`(下方 L192-196 描述要用) | MED | codex 单方独有,grep 验证铁证 |
| MED-2 | `claude-config/CLAUDE.md:191` 「新 session 必须含 user CLAUDE 复杂 plan 节」hard dep | MED | codex 单方独有(Round 1 C3 同问,我当时错降 LOW) |
| MED-3 | `reviewer-claude.md:31` 缺 `/tmp` 临时验证文件例外(对偶 reviewer-codex.md L32 显式给) | MED | codex 单方独有,对偶 diff 铁证 |
| MED-4 | `reviewer-codex.md:28` 「任意额外读目录需求 → 扩展 spawn_session schema + options-builder」runtime reviewer 不能扩 schema | MED | codex 单方独有 |
| MED-5 | 两个 sh.tmpl prompt 写「跑测试」但 claude allowedTools 不含测试命令(B3 fix 引入) | MED | codex 单方独有,Round 1 B3 部分修复引入 |
| LOW-1 | `claude-config/CLAUDE.md:97` 「选项 2/3 ...推荐」 | LOW | 双方共提 |
| LOW-2 | `claude-config/CLAUDE.md:198` 「若产品需要 ...(目前未实现)」留 roadmap | LOW | codex 单方独有 |
| LOW-3 | `claude-config/README.md:15` 「人工同步约定已废弃」历史叙述 | LOW | codex 单方独有 |

#### Round 3 — 4 LOW + 1 *未验证*(全 hardening hints,Round 3 0 HIGH 0 MED ✅ 通过)

| Finding | 文件 | 严重度 | 来源 |
|---|---|---|---|
| LOW | `reviewer-codex.md:60` 「读全部目标文件 ...(根据需要选)」措辞精度差(对偶 reviewer-claude.md L63 「读全部目标文件」直接) | LOW | codex 单方独有 |
| LOW | `reviewer-codex.md:33` 「跑测试、跑命令」与同文件 L24 sandbox 拒读事实不一致 | LOW | codex 单方独有 |
| LOW | `deep-review/SKILL.md:63` cache 路径未 SKILL 内强制 step-0 `.gitignore` 自检 | LOW | codex 单方独有 |
| LOW | `reviewer-codex.sh.tmpl:33` `-C <REPO_ABS_PATH>` 无引号(对偶 claude L60 `cd '<REPO_ABS_PATH>'` 有引号) | LOW | codex 单方独有 |
| 1 INFO | `deep-review/SKILL.md:97 vs 193-194` 两个失败兜底节 | INFO | claude 单方,场景正交合规边界 — 保留 |

### ❌ 反驳(共 1 条)

| Finding | 文件 | 反驳手段 |
|---|---|---|
| Round 3 codex *未验证* | `reviewer-claude.sh.tmpl:65` `Bash(sed *)` 可能允许 `sed -i` / shell redirection 写文件 → 建议收窄到 `Bash(sed -n *)` | **现场实测**:claude `--allowedTools 'Bash(sed *)'` + `--disallowedTools 'Edit,Write,...'` 下:① `sed -i 's/X/Y/' .deep-review-cache/test.txt` → 拒「路径不在允许编辑的目录范围内」 ② `sed 's/X/Y/' in > out` → 拒「Bash tool 的输出重定向被阻止(安全限制)」。**双重物理保证** — sh.tmpl 无需收窄 |

### ❓ 不出现

3 轮共 0 条降级 ❓(每条都被 ✅ 现场验证 / ❌ 反驳 / 双方共提归类)。

## 修复条目(按 Round 分组)

### Round 1 fix(11 处 edit + 1 镜像同步)

- `~/.claude/CLAUDE.md` × 2(C1 L346 / C2 L470)
- `claude-config/CLAUDE.md` × 2(A1 L193 / A4 L109)
- `reviewer-claude.md` × 3(A3 L37 / B1 L79 / B2 insert orientation block)
- `reviewer-codex.md` × 2(A3 L38 / B1 L80)
- `claude-config/README.md` × 1(B5 L38)
- `reviewer-claude.sh.tmpl` × 2(A2 L20 / B3 prompt heredoc)
- `reviewer-codex.sh.tmpl` × 2(A2 L10 / B4 prompt L15)
- `hello-from-deck/SKILL.md` × 1(D1 加「验证通过」+「失败兜底」两节)+ `node scripts/sync-codex-skills.mjs` 同步 codex 镜像

### Round 2 fix(8 处 edit)

- `claude-config/CLAUDE.md` × 4(MED-1 L180 加 `team_task_policy` 签名 + `taskReassignment` 返回 / MED-2 L191 inline cold-start 5 步 / LOW-1 L97 措辞 / LOW-2 L198 删 roadmap)
- `claude-config/README.md` × 1(LOW-3 L15 改当前式)
- `reviewer-claude.md` × 1(MED-3 L31 加 `/tmp` 临时验证文件例外)
- `reviewer-codex.md` × 1(MED-4 L28 删 schema 扩展 directive)
- `reviewer-{claude,codex}.sh.tmpl` × 2(MED-5 删「跑测试」改「跑只读命令」)

### Round 3 fix(4 处 edit + 1 镜像同步)

- `reviewer-codex.md` × 2(LOW L60 cat 措辞精度 / LOW L33 加 `/tmp` 例外 cross-ref)
- `reviewer-claude.md` × 1(对偶同步 L36 加 `/tmp` 例外 cross-ref)
- `deep-review/SKILL.md` × 1(LOW L63 step-0 加 `.gitignore` 自检)+ `sync-codex-skills.mjs` 同步 codex 镜像
- `reviewer-codex.sh.tmpl` × 1(LOW L35 path quoting `-C '<REPO_ABS_PATH>'`)

### 镜像 / 对偶同步验证

- `diff -q` 验证两次 SKILL 镜像同步(claude-config ↔ codex-config)字节级一致
- 7 条约束最终自检(grep 模式扫):所有禁词(`兼容 / 未来 / FUTURE / TODO / 建议 / 可以 / 最好 / 推荐 / 目前未实现 / 人工同步约定已废弃`)在被审 9 文件中 0 命中(meta 引用 / Breaking 历史锚点除外,按约束 2 例外保留)

## 关联 changelog

无 — 本次属内部 prompt 资产质量加固,不引入新功能 / 不改用户感知,不写 changelog。

## 经验沉淀(候选升级)

- **单次决策对抗的局限**:reviewer 单次扫描有 noise + signal,1 轮不能保证 thorough(Round 2 codex 出的 MED-1 / MED-3 / MED-4 都是 Round 1 双 reviewer 都没扫到的旧问题,Round 2 重 review 才浮现)
- **fix 操作可能引入新问题**:Round 1 B3 同步 codex「跑测试」措辞到 claude prompt,没核对 claude allowedTools 实际是否允许 → Round 2 出 MED-5
- **降级判断风险**:Round 1 我把 codex C3「cold-start hard dep」降级 LOW,理由「实际部署 settingSources 满足」 — 错。plugin self-contained 标准要求 inline 关键步骤,「实际满足」是 runtime 偶然性不是合规
- **现场实测胜过措辞收窄**:Round 3 codex 标 *未验证* 想收窄 `Bash(sed *)`,实测铁证 CLI 已有独立写白名单 + redirect 拦截双重物理保证 — 不需收窄
- **以上几点可后续累积到 conventions/tally.md 决定是否升级约定**(目前各 1 次,count < 3 静默)
