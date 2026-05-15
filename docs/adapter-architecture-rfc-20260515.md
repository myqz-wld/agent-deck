---
rfc_id: adapter-architecture-rfc-20260515
plan_id: adapter-architecture-design-20260515
created_at: 2026-05-15
status: in_review
parent_review_id: REVIEW_40
parent_plan_id: codex-claude-adapter-symmetry-20260515
sign_off:
  chapter_1: in_review
  chapter_2: in_review
  chapter_3: in_review
---

# Adapter 架构层 design RFC

> 来源:REVIEW_40 follow-up P2 收口的 3 个架构层 design question(P4 BaseAdapter / 跨 adapter sandbox 继承 / scheduler 命名)。
>
> **本 RFC 仅产 design 决策,不动 src/ 代码**。每章结论需用户 sign-off,实施由后续触发条件命中时另起 implementation plan。

## RFC scope 与不变量

- 输出 = 本文件(3 章对应 3 个 design question)+ 各章实施 follow-up plan stub(等触发条件命中再起实施 plan)
- design 走异构对抗 review(reviewer-claude / reviewer-codex 双对抗,focus = 设计正确性 / 边界 / 实施代价 / 替代方案)
- **不动代码**:本 RFC 阶段 src/ 无任何改动,`pnpm typecheck` 应零变化
- **每章决策都需用户 sign-off**(option 取舍属架构决策,不替用户决策)

## 章节索引

| Chapter | 主题 | sign-off 状态 | 实施 plan stub |
|---|---|---|---|
| 1 | P4 BaseAdapter / CreateSessionOptions 拆判别联合 + typed registry binding (Option D2) | in_review | 待 |
| 2 | 跨 adapter sandbox 继承（Option D 重写 string enum + Option E 重写 warnings 字段） | in_review | 待 |
| 3 | scheduler 命名 convention + 范围定义 + 双类周期 settings 约定 | in_review | 待 |

---

## Chapter 1 — P4 BaseAdapter / CreateSessionOptions 拆判别联合

### 1.1 状态实证

#### 1.1.1 4 adapter 共享代码 surface(grep 统计)

`src/main/adapters/` 下 4 个 adapter:

| Adapter | index.ts 行数 | bridge 实例 | 备注 |
|---|---|---|---|
| `claude-code` | 242 | `ClaudeSdkBridge` | 最重 — pending API + restartWith\* + installer |
| `codex-cli` | 197 | `CodexSdkBridge` | 中等 — restartWithCodexSandbox + setCodexCliPath + summariseEvents |
| `aider` | 111 | `GenericPtyBridge`(共享) | 最薄 — preset fallback + receiveTeammateMessage |
| `generic-pty` | 105 | `GenericPtyBridge` | 最薄 — 强制 config + receiveTeammateMessage |

> 数据点:`adapter/aider/index.ts` 与 `adapter/generic-pty/index.ts` 共用 `GenericPtyBridge` class,两个 adapter 各持一个 bridge instance(sessionId Map 互不干扰)。

**所有 4 adapter 都重复的 boilerplate**(lifecycle + delegation):

```ts
// 每个 adapter 都有同款 5-8 行模板
class XAdapterImpl implements AgentAdapter {
  id = 'X';
  displayName = '...';
  capabilities = { /* 14 个 boolean 字段 */ };
  private bridge: XBridge | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    this.bridge = new XBridge({ emit: ctx.emit, /* ... */ });
  }

  async shutdown(): Promise<void> { /* close bridge or no-op */ }

  async createSession(opts: CreateSessionOptions): Promise<string> {
    if (!this.bridge) throw new Error('X adapter not initialized');
    const handle = await this.bridge.createSession(opts);
    return handle.sessionId;
  }

  async interruptSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.closeSession(sessionId);
  }

  async sendMessage(sessionId: string, text: string, attachments?: ...): Promise<void> {
    if (!this.bridge) throw new Error('X adapter not initialized');
    await this.bridge.sendMessage(sessionId, text, attachments);
  }

  async receiveTeammateMessage(sessionId: string, _from: string, body: string): Promise<void> {
    if (!this.bridge) throw new Error('X adapter not initialized');
    await this.bridge.sendMessage(sessionId, body);
  }
}
```

#### 1.1.2 bridge 公开方法 surface(同名同语义抽象 fit 度高)

3 个 bridge class(`ClaudeSdkBridge` / `CodexSdkBridge` / `GenericPtyBridge`):

| 方法 | claude | codex | generic-pty | 共享语义 |
|---|---|---|---|---|
| `createSession(opts)` | ✅ | ✅ | ✅ | 创建 session,返回 `{sessionId}` |
| `sendMessage(sid, text, attachments?)` | ✅ | ✅ | ✅ | 异步发消息 |
| `interrupt(sid)` | ✅ | ✅ | ✅ | 中断当前 turn |
| `closeSession(sid)` | ✅ | ✅ | ✅ | 永久关闭 + 清状态 |
| `listPending(sid)` | ✅ | ✅(空数组) | ❌ | 取 PendingTab 待响应项 |
| `listAllPending()` | ✅ | ✅(空 Map) | ❌ | 全 session pending 快照 |
| `shutdownAll()` | ❌ | ❌ | ✅ | PTY 专属 |
| `setPermissionTimeoutMs` | ✅ | ❌ | ❌ | 仅 claude |
| `setCodexCliPath` | ❌ | ✅ | ❌ | 仅 codex |
| `setPermissionMode(sid, mode)` | ✅ | ❌ | ❌ | 仅 claude(codex 不支持运行时切) |
| `restartWithPermissionMode` | ✅ | ❌ | ❌ | 仅 claude(冷切) |
| `restartWithClaudeCodeSandbox` | ✅ | ❌ | ❌ | 仅 claude(OS 沙盒冷切) |
| `restartWithCodexSandbox` | ❌ | ✅ | ❌ | 仅 codex(SDK sandbox 冷切) |
| `respondPermission` etc. | ✅ | ❌ | ❌ | 仅 claude(canUseTool 流) |
| `summariseEvents(cwd, events, kind)` | ✅(adapter dispatch) | ✅(adapter dispatch) | ❌ | LLM 摘要 |

**结论**:4 个核心方法(createSession / sendMessage / interrupt / closeSession)在 3 个 bridge class 都同名同语义,**抽象 fit 度极高**。adapter 层在这 4 个方法上的 boilerplate 完全机械重复,正是 P4 BaseAdapter 收口目标。

#### 1.1.3 CreateSessionOptions 字段污染

`src/main/adapters/types.ts:26-125` `CreateSessionOptions` 当前是单个宽接口（option bag），各 adapter 内 createSession 方法签名层 inline narrow 接受 subset（如 claude-code/index.ts:67-92 仅声明接受 `claudeCodeSandbox / extraAllowWrite`，不接 `codexSandbox / genericPtyConfig`）。但 **AgentAdapter interface 层 `createSession?(opts: CreateSessionOptions)` 签名仍是宽接口**，caller 走 interface union 调用时 TS 不阻止误传。

| 字段 | 通用 / adapter 专属 | adapter 接收方 | 其他 adapter 行为 |
|---|---|---|---|
| `cwd` / `prompt` / `resume` / `teamName` / `attachments` | 通用 | 全部 | — |
| `permissionMode` | adapter 专属 | claude（SDK 真生效） | codex（收下但忽略，index.ts:72 注释明示）/ aider / generic-pty（完全忽略，grep 0 命中） |
| `model` | 通用 | claude（SDK 切）+ codex（仅持久化 + warn） | aider / generic-pty 忽略 |
| `codexSandbox` | adapter 专属 | codex | claude / aider / generic-pty 忽略 |
| `claudeCodeSandbox` | adapter 专属 | claude | codex / aider / generic-pty 忽略 |
| `extraAllowWrite` | adapter 专属 | claude（workspace-write 档生效） | 其他忽略 |
| `genericPtyConfig` | adapter 专属 | aider / generic-pty | claude / codex 忽略 |

**问题**:caller(MCP handler / IPC handler / hand-off)调 `adapter.createSession(opts)` 时,不知道哪些字段对当前 adapter 真生效。jsdoc 只能事后说明「其它 adapter 忽略」,TS 编译器不阻止误传 `claudeCodeSandbox: 'strict'` 给 codex adapter。

实际 caller 端 R37 P1-Phase2 已用 `omitUndefined` 收口 spread+ternary(spawn.ts:236),但仍是 **runtime 检查 + jsdoc 信任**,不是 TS 类型层面强约束。

#### 1.1.4 漂移频率(触发条件)实证

REVIEW_37 R1 「P4」finding 提出,REVIEW_40 P2 留 architectural plan 触发条件:**加新 adapter / 4 adapter 间 sandbox/permission 行为漂移频繁修 ≥ 3 次**。

历史漂移修法 grep:`git log --oneline --all -- 'src/main/adapters/**'` 命中 **113 commit**（R1 reviewer-claude 现场实证），按 user CLAUDE.md tally count ≥ 3 触发条件实际超 30+ 倍。典型批次:
- parity-plan Phase A（已 commit 完成）+ Phase B（worktree-cross-adapter-parity-20260515 仍 in-progress 跑 f95e09d）：v019 sessions.extra_allow_write / claude+codex 持久化 / regression test / recoverer waiter 等 5+ commit
- symmetry-plan P2/P3：codex 端 6 commit 字面镜像 claude pattern（restart-controller / recoverer / cwdExists thunk / sandbox-resolve 直读 / pool jsdoc / extraAllowWrite 修正）
- CHANGELOG_74 三段：c3f92b5 DB / bf3db4c IPC / 8ad625c 抽 RestartController + claude 加 sandbox capability
- 跨 adapter 早期：ed73637 codex A2b / 32b6923 UI / f33e01a CLI / 810e223 IPC handOff 透传
- REVIEW_36 / 33：2dd02b1 11 真问题修

**结论**:漂移触发条件已**远超**命中（113 commit vs ≥ 3 阈值），Option D2（详 §1.3）实施 plan 应作为本 RFC sign-off 后**立即触发**。但本 RFC 仍仅产 design 决策不动代码 — 实施由后续 implementation plan 承接（详 §1.8 迁移路线 Step 0 等 parity-plan 收口约束）。

### 1.2 动机

1. **TS 类型层强约束**:`CreateSessionOptions` 拆判别联合后,caller 误传 `codexSandbox` 给 claude adapter 编译期就报错
2. **boilerplate 收口**:4 adapter 各 5-8 行 lifecycle + delegation 模板,新加第 5 个 adapter 时不必复制粘贴
3. **漂移可见性**:adapter 间共享行为(如 receiveTeammateMessage 4 adapter 完全相同)集中维护 1 处,而非 4 处独立 drift
4. **capability gating 落到类型**:某 adapter 不支持的方法(如 codex 的 setPermissionMode)在类型层就不出现,避免运行时 throw `'not supported'`

### 1.3 设计 option

#### Option A — 抽象基类(class BaseAdapter)

```ts
abstract class BaseAdapter<TBridge extends BridgeContract> implements AgentAdapter {
  abstract id: string;
  abstract displayName: string;
  abstract capabilities: AdapterCapabilities;

  protected bridge: TBridge | null = null;
  protected abstract createBridge(ctx: AdapterContext): TBridge;
  protected abstract get notInitMessage(): string;

  async init(ctx: AdapterContext): Promise<void> {
    this.bridge = this.createBridge(ctx);
    await this.afterInit?.(ctx);
  }

  async createSession(opts: CreateSessionOptions): Promise<string> {
    if (!this.bridge) throw new Error(this.notInitMessage);
    const handle = await this.bridge.createSession(this.narrowOpts(opts));
    return handle.sessionId;
  }

  // 同款 5-8 行 lifecycle + delegation 全在 base
  async interruptSession(sid: string): Promise<void> { /* ... */ }
  async closeSession(sid: string): Promise<void> { /* ... */ }
  async sendMessage(sid: string, text: string, attachments?: UploadedAttachmentRef[]) { /* ... */ }
  async receiveTeammateMessage(sid: string, _from: string, body: string) {
    return this.sendMessage(sid, body); // 4 adapter 同款,base 兜底实现
  }

  // 子类只覆 narrowOpts 把通用 union 缩成 adapter 专属 subset
  protected abstract narrowOpts(opts: CreateSessionOptions): TBridgeCreateOpts;
}

class ClaudeCodeAdapterImpl extends BaseAdapter<ClaudeSdkBridge> {
  id = 'claude-code';
  capabilities = { /* ... */ };
  protected createBridge(ctx) { return new ClaudeSdkBridge({ /* ... */ }); }
  protected narrowOpts(opts) {
    return { cwd, prompt, resume, claudeCodeSandbox, extraAllowWrite, model, ... }; // 仅 claude 接受字段
  }
  // 加 claude 专属:respondPermission / restartWithPermissionMode etc.
}
```

**收益**:
- 4 adapter 各省 5-8 行 boilerplate(总计 ~30 行)
- `narrowOpts` 集中处理「哪些字段对本 adapter 生效」,jsdoc 可移到 `narrowOpts` 注释,但仍是 runtime 投影非类型约束
- adapter 无法忘实现 lifecycle,base 强制走同款模板

**代价**:
- TS 类继承 + 泛型 `<TBridge>` 增加阅读成本
- `narrowOpts` 仍是 runtime 投影,**不解决** 1.2 第 1 项「caller 误传 TS 编译期不报错」
- 子类需对 `bridge` 做 null 检查吗?base 强制走 `notInitMessage` throw,子类专属方法仍要重复 `if (!this.bridge) throw` boilerplate(因 TS narrowing)
- claude / codex 专属方法(restartWith\* / setX / pendings)无法纳入 base,这部分仍各 adapter 独立写

> **R1 反馈**：adapter 当前已在 createSession 方法签名层 inline narrow opts type（如 claude-code/index.ts:67-92 / codex-cli/index.ts:69-99），各自只声明接受字段。Option A `narrowOpts` 把这一 narrow 移到 base class，仅减少 boilerplate；不解决 caller 端 TS 编译期约束（caller 拿 `AgentAdapter` interface union 签名仍 type-unsafe）— 这是 Option D / D2 才解决的根本问题。

#### Option B — Mixin / 函数式组合

```ts
function createAdapterShell<TBridge>(
  config: { id: string; displayName: string; capabilities: AdapterCapabilities },
  factory: (ctx: AdapterContext) => TBridge,
): { core: AdapterCore<TBridge>; extend: <T>(t: T) => AgentAdapter & T } { /* ... */ }

const claudeCodeAdapter = createAdapterShell(
  { id: 'claude-code', displayName: 'Claude Code', capabilities: {...} },
  (ctx) => new ClaudeSdkBridge({ ... }),
).extend({
  async respondPermission(sid, rid, resp) { /* claude 专属 */ },
  async restartWithPermissionMode(sid, mode, prompt) { /* claude 专属 */ },
});
```

**收益**:
- 比 class 继承更扁平(没有 `super` / `protected` 心智负担)
- 函数式组合更易加新 capability(如未来加 `installIntegration` 直接 extend)
- 类型层 `AgentAdapter & T` 联合可让 TS 反推子类暴露的方法

#### Option C — 不动 + helper 函数收口

```ts
// 仅抽 helper,不抽基类
function delegateOrThrow<R>(bridge: B | null, msg: string, fn: (b: B) => Promise<R>): Promise<R> {
  if (!bridge) throw new Error(msg);
  return fn(bridge);
}

class ClaudeCodeAdapterImpl implements AgentAdapter {
  // ...
  async createSession(opts) {
    return delegateOrThrow(this.bridge, 'claude-code adapter not initialized',
      (b) => b.createSession(opts).then(h => h.sessionId));
  }
}
```

**收益**:
- **零结构变更**,只把 5-8 行 boilerplate 缩到 1 行 helper 调用
- TS 类型保持现状(adapter 仍是独立 class implements AgentAdapter)
- 任何时候反向 inline 回去成本 = 0
- adapter 间 drift 风险与现状一致(jsdoc + runtime 行为为权威)

**代价**:
- 不解决 `CreateSessionOptions` 拆判别联合(这是独立改动,不靠基类)
- 不收口「lifecycle 模板」(仍 4 处重复 init / shutdown 形式)
- 仅治标(boilerplate)不治本(漂移可见性)

#### Option D(独立子改动,可与 A/B/C 任一组合)— `CreateSessionOptions` 拆判别联合

```ts
type CreateSessionOptions =
  | ({ agentId: 'claude-code' } & ClaudeCreateOpts)
  | ({ agentId: 'codex-cli' } & CodexCreateOpts)
  | ({ agentId: 'aider' } & PtyCreateOpts)
  | ({ agentId: 'generic-pty' } & PtyCreateOpts);

interface ClaudeCreateOpts {
  cwd: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
  model?: string;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  extraAllowWrite?: readonly string[];
}

interface CodexCreateOpts {
  cwd: string;
  prompt?: string;
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
  model?: string;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
}

interface PtyCreateOpts {
  cwd: string;
  prompt?: string;
  attachments?: UploadedAttachmentRef[];
  genericPtyConfig?: GenericPtyConfig;
}
```

**收益**:
- TS 编译期阻止 caller 误传 `codexSandbox` 给 claude adapter
- adapter 内 `narrowOpts` 实现可类型自动化(switch on `agentId`)
- 字段污染消失(`AgentAdapter.createSession?` 签名仍是 `CreateSessionOptions`,TS 用 `agentId` 自动 narrow)

**代价**:
- caller 端(spawn.ts handler / IPC adapters.ts handler / hand-off-session-impl)需把 `agentId` 字段塞到所有 `createSession` 调用点 — 已有 ~5-8 个 caller 命中
- omitUndefined / spread 模式(spawn.ts:236)需重写适配新类型
- 第 5 个 adapter 加进来时新加 union arm — 但加 adapter 本来就是大改动,不算成本
- adapter 内的 `createSession(opts: { ... inline 解构 })` 当前 inline type 需移到 `XCreateOpts` interface — jsdoc 注释也要分散到各 interface

> **R1 反馈**：仅 `CreateSessionOptions` 加判别字段不足以兑现 caller 端 TS 强约束 — `adapterRegistry.get(args.adapter)` 返回非泛型 `AgentAdapter`，caller 拿到的实例与 opts.agentId 无类型层 binding；caller 仍需显式 `switch(args.adapter)` 或调 helper 强制 switch 穷尽，TS 才能在编译期阻止误传。完整解决方案见下方 Option D2。

#### Option D2 — D + typed registry binding（R1 双方独立提出 → lead 强烈推荐升级）

R1 reviewer-claude + reviewer-codex 都独立指出 D 的局限。Option D2 在 D 基础上加 typed registry overload + builder helper：

```ts
// 1. 判别联合（与 D 同款）
type CreateSessionOptions =
  | ({ agentId: 'claude-code' } & ClaudeCreateOpts)
  | ({ agentId: 'codex-cli' } & CodexCreateOpts)
  | ({ agentId: 'aider' } & PtyCreateOpts)
  | ({ agentId: 'generic-pty' } & PtyCreateOpts);

type CreateSessionOptionsByAdapter = {
  'claude-code': ClaudeCreateOpts;
  'codex-cli': CodexCreateOpts;
  'aider': PtyCreateOpts;
  'generic-pty': PtyCreateOpts;
};

// 2. typed registry overload
type AdapterIdMap = {
  'claude-code': ClaudeCodeAdapter;
  'codex-cli': CodexCliAdapter;
  'aider': AiderAdapter;
  'generic-pty': GenericPtyAdapter;
};

interface AdapterRegistry {
  get<T extends keyof AdapterIdMap>(id: T): AdapterIdMap[T] | undefined;
  get(id: string): AgentAdapter | undefined; // string fallback 兼容动态调用点
}

// 3. builder helper 强制 exhaustive switch
function buildCreateSessionOptions<T extends keyof CreateSessionOptionsByAdapter>(
  agentId: T,
  raw: CreateSessionOptionsRaw,
): CreateSessionOptionsByAdapter[T] & { agentId: T } {
  switch (agentId) {
    case 'claude-code':
      return { agentId, ...narrowToClaudeOpts(raw) } as any;
    case 'codex-cli':
      return { agentId, ...narrowToCodexOpts(raw) } as any;
    case 'aider':
    case 'generic-pty':
      return { agentId, ...narrowToPtyOpts(raw) } as any;
    default: {
      const _exhaustive: never = agentId;
      throw new Error(`unknown agentId: ${_exhaustive}`);
    }
  }
}
```

caller 端使用：

```ts
// 旧：
const adapter = adapterRegistry.get(args.adapter); // : AgentAdapter | undefined
adapter?.createSession({ ... }); // opts 是 union，TS 不阻止误传 codexSandbox 给 claude

// 新（D2）：
const adapter = adapterRegistry.get(args.adapter as 'claude-code'); // : ClaudeCodeAdapter | undefined
const opts = buildCreateSessionOptions('claude-code', rawArgs); // : ClaudeCreateOpts & { agentId: 'claude-code' }
adapter?.createSession(opts); // opts 类型与 adapter 实例一致 — TS 编译期 narrow
```

**收益**(D 基础上加):
- caller 端 TS 自动 narrow 拿到具体 adapter 实例（不必手动 cast）
- adapter 实例上的 adapter-专属方法（如 `respondPermission` 仅 claude / `restartWithCodexSandbox` 仅 codex）TS 自动 visible
- `buildCreateSessionOptions` 强制 exhaustive switch，加新 adapter 漏 arm TS 编译期报错
- D 收益（编译期阻止字段误传）+ caller 端 TS 实例类型 binding

**代价**(D 基础上加):
- typed registry overload + builder helper 代码量比 D 多 ~50 行
- adapter 实例命名（`ClaudeCodeAdapter` / `CodexCliAdapter` 等）需 export class type，原 `claudeCodeAdapter: AgentAdapter` 单一 export 改 `claudeCodeAdapter: ClaudeCodeAdapter` typed export
- caller 端如不主动用 typed registry overload 仍走 `AgentAdapter` union（兼容 fallback 保留，但失 TS narrow 收益）

### 1.4 推荐（R1+R1.5 后定）

**lead 推荐**（R1 双方独立 + R1.5 反驳轮验证）：

- **Option D2（D + typed registry binding）推 ✅ 强烈建议立即落**：
  - 漂移频率已远超触发阈值（§1.1.4 实证 113 commit vs 阈值 ≥ 3）
  - R1 双方独立指出 D 单独不够（caller 端 TS 实例类型 binding 必须）
  - 实施 plan 应作为本 RFC sign-off 后立即触发（详 §1.8 Step 0 等 parity-plan 收口约束）
- **Option D（仅判别字段，不带 typed registry）推 ⚠️ 不推荐单独实施**：能阻止字段误传但 caller 端仍需手动 cast adapter 实例；若 D2 typed registry binding 实施代价过大可降级到 D + 接受手动 cast 副作用
- **Option A（抽象基类）推 ⚠️ 暂不实施**：仅治 30 行 boilerplate（收益小），class 继承 + 泛型 `<TBridge>` 心智成本大；若加第 5 个 adapter 再考虑
- **Option B（Mixin）推 ❌ 拒绝**：函数式组合在 TS 类型推导上易踩 generic 推断陷阱；新增 abstraction 不值
- **Option C（helper 函数）推 ❓ 可选**：与 D2 正交，可在 D2 落地后顺手加 `delegateOrThrow` helper 把 5-8 行 boilerplate 缩到 1 行 — 收益小，可不做

### 1.5 Touchpoint estimate（若 D2 实施）

| 改动点 | 文件 | LOC 估算 |
|---|---|---|
| 拆 `CreateSessionOptions` 为 4 union arm + 4 interface（D 部分） | `src/main/adapters/types.ts` | +40 / -100（jsdoc 分散） |
| typed registry overload + builder helper（D2 部分） | `src/main/adapters/registry.ts` + 各 adapter `index.ts` 加 typed export | +50 / -10 |
| adapter 内 `createSession(opts: {inline})` 改 `opts: XCreateOpts` | 4 adapter index.ts | -20 / +20 |
| caller 端塞 `agentId` 字段 + 改用 typed registry | 5 处生产 caller：`spawn.ts:230` / `cli.ts:268` / `cli.ts:315` / `ipc/adapters.ts:174` / `ipc/sessions.ts:133` | +15 / -0 |
| `omitUndefined` spread 模式调整 | `spawn.ts:236` + `hand-off-session.ts:281-303` | +10 / -10 |
| 测试 fixture 字段调整 | `__tests__/spawn-guards.test.ts` / `hand-off-session.handler-cwd-generic.test.ts` 等 | +30 / -0 |
| **合计** | — | **~+165 / -140** |

> R1 反馈：caller 命中点实证 5 处生产（grep `adapter\.createSession\(` 排除 __tests__）；hand-off 真实组装点是 `hand-off-session.ts:281-303` 而非 `hand-off-session-impl.ts`。

### 1.6 实施代价 / 风险

- **caller migration 一次性集中**:不像漂移修法分散多次,而是一次 PR 收口,反而风险**低**于现状
- **TS narrowing 副作用**:adapter 内拿到 `opts: ClaudeCreateOpts` 后,bridge `createSession` 签名也需 narrow 否则 type mismatch — 可能需 bridge 端也加判别(或 cast)
- **第 5 个 adapter 加入成本**:新加 union arm + 新加 caller 分支,与现状对比成本相当或略低(因 TS 强约束让漂移检测变早)

### 1.7 Test plan

- 单测:`__tests__/adapter-create-options.type-narrow.test.ts` 用 TS `expectError` 断言 `claudeCodeAdapter.createSession({ agentId: 'claude-code', codexSandbox: 'read-only' })` 编译报错
- 集成:复跑 `__tests__/spawn-guards.test.ts` / `__tests__/hand-off-session.handler-cwd-generic.test.ts` 验证 caller migration 不破坏行为
- regression:typecheck + 全单测一遍

### 1.8 迁移路线（若 D2 + C 同步落地）

0. **Step 0**（前置约束）：等 parity-plan Phase A+B 收尾（worktree-cross-adapter-parity-20260515 仍在 Phase B 跑 f95e09d，extraAllowWrite 持久化字段位置仍在调）→ 与 parity-plan owner 协调 `extraAllowWrite` 字段最终归属（CreateSessionOptions 公共 vs ClaudeCreateOpts 专属）后再触发 Option D2 实施。否则两个 plan 串行修同款字段会冲突 + 重复 churn
1. **Step 1**：`adapters/types.ts` 拆 4 interface + 判别联合；adapter 内 inline opts type 改引用 interface（机械）
2. **Step 2**：typed registry overload + `buildCreateSessionOptions` builder helper；adapter `index.ts` 改 typed export（`claudeCodeAdapter: ClaudeCodeAdapter` 替换 `: AgentAdapter`）
3. **Step 3**：caller 端塞 `agentId` + 改用 typed registry；`omitUndefined` spread 模式调适
4. **Step 4**：adapter 内 `if (!this.bridge) throw` 改 `delegateOrThrow` helper（可选 Option C 顺手做）
5. **Step 5**：typecheck + 全单测 + 异构对抗 review

---

## Chapter 2 — 跨 adapter sandbox 继承

### 2.1 状态实证

#### 2.1.1 当前 fallback chain(spawn.ts:131-135)

```ts
// src/main/agent-deck-mcp/tools/handlers/spawn.ts:131-135
const effectivePermissionMode =
  args.permission_mode ?? leadRecord?.permissionMode ?? undefined;
const effectiveCodexSandbox = args.codex_sandbox ?? leadRecord?.codexSandbox ?? undefined;
const effectiveClaudeCodeSandbox =
  args.claude_code_sandbox ?? leadRecord?.claudeCodeSandbox ?? undefined;
```

**特点**:
- 三独立字段(`permissionMode` / `codexSandbox` / `claudeCodeSandbox`)各自 fallback,**互不映射**
- 假设 lead 是 claude session(设 `claudeCodeSandbox: 'strict'` / `codexSandbox: undefined`),spawn codex teammate:
  - `effectiveCodexSandbox = args.codex_sandbox ?? undefined ?? undefined = undefined`
  - codex adapter 内部 fallback `settingsStore.get('codexSandbox')` 全局值(默认 'workspace-write')
- 反向:lead 是 codex(设 `codexSandbox: 'read-only'`),spawn claude teammate:
  - `effectiveClaudeCodeSandbox = args.claude_code_sandbox ?? undefined ?? undefined = undefined`
  - claude adapter 内部 fallback `settingsStore.get('claudeCodeSandbox')`(默认 'off')

**结论**:跨 adapter sandbox 当前**完全不继承** — 是显式设计选择(spawn.ts:123-127 注释明确写「sandbox 继承解决 reviewer-codex 报『外层 Claude Code sandbox 拦了 codex in-process app-server 初始化』的根因」,但仅同 adapter 内继承)。

#### 2.1.2 sandbox enum 三档语义对应(实证)

| level | claude `claudeCodeSandbox` | codex `codexSandbox` | 字面差异 |
|---|---|---|---|
| 无沙盒 | `'off'` | `'danger-full-access'` | 完全不同字面;语义都是「不限」但 claude `'off'` 仍走 canUseTool 审批 model 命令,codex `'danger-full-access'` 完全跳过审批 |
| 中等(可写 cwd) | `'workspace-write'` | `'workspace-write'` | **字面相同** |
| 只读 | `'strict'` | `'read-only'` | 字面差异;claude `'strict'` 多了 `failIfUnavailable: true` 不可用时 query emit error,codex `'read-only'` 无 OS 沙盒概念 |

**结论**:三档对应**语义近似但非等价**:
- `workspace-write ↔ workspace-write` 字面相同,但 claude 多了 `excludedCommands` / `allowUnsandboxedCommands` / `denyRead` 等结构化子配置,codex 无对应概念
- `strict ↔ read-only` 都是封写,但 claude 的 OS-level 沙盒(macOS sandbox-exec)与 codex 的 SDK approvalPolicy 是不同 enforcement 层
- `off ↔ danger-full-access` 字面差异最大,且 claude `'off'` 的 canUseTool 审批通道与 codex `'danger-full-access'` 的「完全跳过」**反方向**（claude `'off'` 仍走 canUseTool 审批 model 命令实际**比** codex `'danger-full-access'` 更安全）

#### 2.1.2.1 lossy 详细清单（R1 双方独立 + lead 现场实证）

`buildSandboxOptions`（claude `sandbox-config.ts:131-200`）返回 `{sandbox: SandboxSettings}` 含 **7 类结构化字段**；codex 端 `codexSandbox` 仅是单 enum string，无任何子配置：

| claude 端结构化字段 | codex 端对应 | 跨 adapter 映射后状态 |
|---|---|---|
| `enabled` | （隐含） | enum 单字段表达，丢 boolean 显式控制 |
| `failIfUnavailable: true`（strict 档）| 无对应 | 沙盒不可用时 codex 静默继续运行（claude strict 会 emit error） |
| `autoAllowBashIfSandboxed: true` | 无对应 | 丢 |
| `allowUnsandboxedCommands: true/false` | 无对应（codex 默认 approvalPolicy: 'never' 等价 false） | 丢策略柔性 |
| `excludedCommands: [...]`（20+ dev 命令豁免） | 无对应 | 丢豁免清单（git/pnpm/npm/cargo 等可能撞 sandbox） |
| `filesystem.allowWrite: [cwd, /tmp, ~/.cache/claude-code]` | （隐含 codex `workspace-write` cwd） | 丢 /tmp / cache 豁免 |
| `filesystem.denyRead: [~/.ssh, ~/.aws, ~/.config, ~/.kube, ~/.npmrc, ~/.zsh_history, Keychains, Cookies]` | 无对应 | **严重** — 跨 adapter 映射后 codex teammate 仍可读敏感目录，claude denyRead 防护失效 |

**反向同款 lossy**：codex 端无结构化字段映射回 claude 时，claude 默认填空（无 excludedCommands → dev 命令进沙盒撞 / 无 denyRead → 失敏感目录防护）。

**结论**：跨 adapter sandbox 平凡映射（如 Option A）会丢失至少 6 类结构化保护（enabled / failIfUnavailable / excludedCommands / allowUnsandboxedCommands / allowWrite 豁免 / denyRead 敏感名单），用户**以为继承了 strict 实际丢了 denyRead 仍能读 ~/.ssh** 是反模式。这是 §2.3 Option A 拒绝 + Option D 重写 string enum（仅 strict→read-only / workspace-write→workspace-write 映射，off / danger-full-access 不映射）的关键论据。

#### 2.1.3 触发场景实证(reviewer-codex R1 HIGH-2 finding)

REVIEW_40 P2 表格(reviews/REVIEW_40.md:74)记录的实质场景:

> reviewer-codex HIGH-2 「跨 adapter sandbox 继承断链」: 实质 design question — sandbox enum value 不平凡映射(spawn.ts:131 显式分两条 fallback chain 是设计选择不是 bug),本 plan 不 fix,留架构 plan

reviewer-codex 报的 case 是:lead 是 claude(用户设 `claudeCodeSandbox: 'strict'` 因为只读 review)→ spawn codex teammate(本意继续只读 review)→ codex teammate 跑在 codex 默认 `'workspace-write'`(可改文件)→ **violates 用户最初 strict 意图**。

但 plan 标注「实质 design question 不是 bug」,因 sandbox enum value 不平凡映射,无法机械继承。

### 2.2 动机

1. **保留用户安全意图**:lead 设 strict 跑 review,spawn 出 teammate 不应擅自宽松
2. **明确边界**:跨 adapter sandbox 是 explicit per-target default(当前)还是 implicit inheritance(opt-in / opt-out),需文档化决策让未来加 adapter 不漂移
3. **避免「沉默宽松化」反模式**:UI 看不出 teammate 比 lead 沙盒更宽,误以为继承

### 2.3 设计 option

#### Option A — 平凡映射(自动跨 adapter 继承)

定义跨 adapter 三档对应表,spawn 时自动映射:

```ts
const SANDBOX_LEVEL_MAP: Record<ClaudeSandboxMode, CodexSandboxMode> = {
  'off': 'danger-full-access',
  'workspace-write': 'workspace-write',
  'strict': 'read-only',
};
const REVERSE_MAP: Record<CodexSandboxMode, ClaudeSandboxMode> = {
  'workspace-write': 'workspace-write',
  'read-only': 'strict',
  'danger-full-access': 'off',
};

// spawn.ts handler:
function inheritSandbox(targetAdapter: AdapterId, leadRecord: SessionRecord | null) {
  if (!leadRecord) return undefined;
  if (targetAdapter === 'claude-code' && leadRecord.codexSandbox) {
    return REVERSE_MAP[leadRecord.codexSandbox];
  }
  if (targetAdapter === 'codex-cli' && leadRecord.claudeCodeSandbox) {
    return SANDBOX_LEVEL_MAP[leadRecord.claudeCodeSandbox];
  }
  return undefined;
}
```

**收益**:
- 用户安全意图自动保留(lead strict → teammate 也 strict)
- 0 caller 改动(自动透传)

**代价**:
- 映射 lossy:claude `'workspace-write'` 的 `excludedCommands` / `denyRead` 等结构化字段在 codex 端**没有对应**,只能丢
- 假设违反:`'off' ↔ 'danger-full-access'` 不等价(claude 仍走 canUseTool 审批 model 命令,codex 完全跳过)— 用户设 claude `'off'`(以为是「我自己审批所有命令」)spawn codex teammate(变 `'danger-full-access'` 完全跳过审批)语义错位
- **debug 难**:用户看 codex teammate 的 `codexSandbox: 'workspace-write'` 不知道是「lead claude `workspace-write` 映射来」还是「codex 全局默认」

#### Option B — Abstract sandbox level(三档枚举抽象)

新增上层 enum `AbstractSandboxLevel = 'unrestricted' | 'workspace-write' | 'read-only'`,各 adapter 内自己映射到具体字段:

```ts
type AbstractSandboxLevel = 'unrestricted' | 'workspace-write' | 'read-only';

interface SessionRecord {
  // 原 claudeCodeSandbox / codexSandbox 二选一保留 raw 值
  // 新加 abstract level(SSOT)
  abstractSandboxLevel?: AbstractSandboxLevel;
}

// adapter 内 createSession:
function resolveSandbox(opts: { abstractLevel?: AbstractSandboxLevel }) {
  if (opts.abstractLevel) {
    return CLAUDE_LEVEL_MAP[opts.abstractLevel]; // adapter 自己决定如何 enforce
  }
}
```

**收益**:
- 跨 adapter 继承走 abstract level,语义一致
- 未来加新 adapter 时只需提供「我如何把 abstract level 翻译到我的 enforcement 层」

**代价**:
- 双轨制(raw enum + abstract level),用户切档需理解两层
- 现有 settings UI / CLI / IPC 全要改(claudeCodeSandbox / codexSandbox 仍要保留兼容,abstractLevel 仅 cross-adapter 路径用)
- 不能精确表达 adapter 专属字段(`excludedCommands` / `allowUnsandboxedCommands`)— 这些用户在 settings 单独设
- `abstractLevel: 'unrestricted'` 撞 claude `'off'` 与 codex `'danger-full-access'` 的语义差异(canUseTool 是否触发)— **没解决根本问题**

#### Option C — Explicit per-target adapter default(当前)

保持 spawn.ts:131 现状 — 跨 adapter 不继承,target adapter 走自己 settings 全局值。

**收益**:
- **零改动**,行为可预测
- 没有 lossy 映射,不会引入「沉默宽松化」反模式
- adapter 专属字段(`excludedCommands` etc.)不会被跨 adapter 路径稀释

**代价**:
- 用户安全意图**不自动保留**(lead claude strict → codex teammate 默认 workspace-write 可改文件)
- UX 上需用户记住「跨 adapter 时手动调 sandbox」,容易遗漏
- 长期反复踩坑可能升级到 conventions/tally

#### Option D（重写）— Opt-in 字段（string enum，安全优先）

**R1 codex HIGH 反例**：原 `inherit_sandbox: boolean` 设计在默认配置下**实际放宽**安全意图 — settings.ts:393-394 实证 claude 默认 `'off'` / codex 默认 `'workspace-write'`，`inherit_sandbox: true` 在 lead claude `'off'` → codex teammate 时会按 Option A 平凡映射变 `'danger-full-access'`（比 codex 默认 workspace-write 还宽）。

重写为 string enum 限制映射方向，仅按更严档对齐：

```ts
mcp__agent-deck__spawn_session({
  adapter: 'codex-cli',
  team_name: 'review-team',
  prompt: '...',
  inherit_sandbox: 'restrictions-only',  // 仅 strict→read-only / workspace-write→workspace-write 映射
                                          // off / danger-full-access 不映射 — 默认值场景不放宽
});

// 想完全继承（含放宽语义）需显式加危险字段：
mcp__agent-deck__spawn_session({
  adapter: 'codex-cli',
  inherit_sandbox: 'restrictions-only',
  allow_unrestricted_mapping: true,  // 显式同意 off↔danger-full-access 映射，UI 高亮警告
});
```

映射表（仅 restrictions-only 模式）：

| lead 端档位 | target adapter 映射后 | 备注 |
|---|---|---|
| claude `'strict'` | codex `'read-only'` | 安全对齐 |
| claude `'workspace-write'` | codex `'workspace-write'` | 字面同 |
| claude `'off'` | **不映射** → codex 默认 | 不放宽（claude `'off'` 的 canUseTool 审批与 codex `'danger-full-access'` 不等价） |
| codex `'read-only'` | claude `'strict'` | 安全对齐 |
| codex `'workspace-write'` | claude `'workspace-write'` | 字面同 |
| codex `'danger-full-access'` | **不映射** → claude 默认 | 不放宽 |

**收益**：
- 默认行为 = Option C（零回归 / 无 silently 宽松化）
- 用户显式 `'restrictions-only'` 时仅安全方向映射（lead 设严 → teammate 也严）；零不安全映射风险
- `allow_unrestricted_mapping: true` 提供 escape hatch 但需用户显式同意 + UI 高亮警告
- 与 `permission_mode` / `codex_sandbox` / `claude_code_sandbox` 字段并存（显式覆盖优先级最高）

**代价**：
- caller 必须知道字段值（`'restrictions-only'` vs boolean），不是 zero-config
- 仍涉及映射 lossy（详 §2.1.2.1 lossy 详细清单），但仅在安全方向 + 用户显式同意
- spawn handler + hand_off_session handler 多两个参数 + 文档/schema 描述（详 §2.5 touchpoint）

#### Option E（重写）— Warning 走 SpawnSessionResult 字段（不止 console.warn）

**R1 双方独立反例**：原 `console.warn` 只输出到主进程日志，MCP caller / lead conversation / SessionDetail UI 都看不到，UX 上几乎无效。

重写为 `warnings: string[]` 通过 SpawnSessionResult / HandOffSessionResult 返回字段 + emit message 到 lead session 双发：

```ts
// schemas.ts SpawnSessionResult 加字段
interface SpawnSessionResult {
  sessionId: string;
  // ... 既有字段
  warnings?: string[];  // 新增
}

// spawn handler 检测条件
if (
  args.inherit_sandbox === undefined &&
  leadRecord?.claudeCodeSandbox === 'strict' &&
  targetAdapter === 'codex-cli' &&
  !args.codex_sandbox
) {
  result.warnings = [
    `lead claude is strict, but codex teammate spawned with default workspace-write. Consider inherit_sandbox: 'restrictions-only' to align security intent.`,
  ];
  // emit message 到 lead session 让 SessionDetail UI 也能看到
  ctx.emit({ kind: 'message', sessionId: leadSid, text: `[warn] ${result.warnings[0]}` });
}
```

**收益**：
- MCP caller 拿到 result.warnings 立即知道
- lead session 收到 user-role message 触发 turn 处理
- 实施代价低（result interface 加字段 + handler 加 if + emit）

**代价**：
- SpawnSessionResult / HandOffSessionResult interface 都要加 `warnings?: string[]`
- 相关单测断言要加 warnings 检查

#### Option F — 跨 adapter 时 spawn handler 硬性 reject + 强制用户表态

`if (lead 非默认 sandbox + 跨 adapter spawn + caller 没显式传 inherit_sandbox / codex_sandbox / claude_code_sandbox)` → spawn handler 直接 reject，要求用户显式传字段表态。

```ts
if (
  leadRecord?.claudeCodeSandbox && leadRecord.claudeCodeSandbox !== 'off' &&
  targetAdapter === 'codex-cli' &&
  args.inherit_sandbox === undefined &&
  args.codex_sandbox === undefined
) {
  throw new Error(
    `Cross-adapter spawn requires explicit sandbox decision. ` +
    `Lead claude is '${leadRecord.claudeCodeSandbox}'; codex teammate has no inherited value. ` +
    `Choose: inherit_sandbox: 'restrictions-only' | codex_sandbox: <explicit>`,
  );
}
```

**收益**：
- UX 强制决策，绝无 silently 宽松化
- 用户每次跨 adapter spawn 都明确 sandbox 意图

**代价**：
- 自动化 / 脚本场景受阻（必须每次显式传字段）
- caller 增加心智负担（每个 spawn 都要表态）

#### Option G — codex 视角 enum 字段（与 D 同款 string enum 不同语义）

R1 reviewer-codex 单独提出的设计：`inherit_sandbox: 'restrictions-only' | 'mirror' | 'none'` 三档枚举，更细粒度控制：

- `'none'`（默认）：完全不继承，target adapter 走自己 settings 全局值（同 Option C）
- `'restrictions-only'`：仅安全方向映射（同 Option D 重写后），off / danger-full-access 不映射
- `'mirror'`：完全平凡映射（同 Option A），含 off↔danger-full-access — 需 caller 显式选择，UI 高亮警告

**收益**：
- 比 D 重写的 boolean + escape hatch 更清晰（三档枚举语义自显）
- 'mirror' 把 Option A 的危险映射作为显式选项保留（不删除能力，但默认隔离）

**代价**：
- 与 D 重写后语义重叠 — D `restrictions-only` + `allow_unrestricted_mapping: true` 等价 G `mirror`，多一字段表达同一概念
- caller 需理解 3 档语义（D 仅 1 档 + 1 escape hatch 字段更轻）

### 2.4 推荐（R1+R1.5 后定）

**lead 推荐**（R1 双方独立 + R1.5 反驳轮验证）：

- **Option D 重写 + Option E 重写 推 ✅ 接受**：
  - D string enum (`'restrictions-only'` / 可选 `allow_unrestricted_mapping`) 仅安全方向映射，零不安全 silently 宽松化
  - E warnings: string[] 字段 + emit message 双发，UX 真可见
  - **配合触发条件明确**：E 触发 = D 字段未传 + lead 非默认 sandbox + 跨 adapter spawn；D 字段显式传时 E 不再 warn（用户已表态）
  - **同时加 spawn_session + hand_off_session schema**（详 §2.5 touchpoint）
- **Option A（自动平凡映射）推 ❌ 拒绝**：lossy 映射详见 §2.1.2.1（7 类结构化字段丢失，含 denyRead 敏感目录）+ off↔danger-full-access 反方向危险 + debug 难
- **Option B（abstract level）推 ❌ 拒绝**：双轨制 + 现有 UI/CLI 全改，根本问题（off vs danger-full-access 不等价）没解决
- **Option C（explicit default，当前）推 ⚠️ 现状保留**：作为 D 默认行为兜底
- **Option F（硬 reject）推 ❓ 候选**：UX 强制决策最严格但自动化场景受阻；可作为 D + E 推不动用户主动用时的备选
- **Option G（codex enum 三档）推 ❌ 拒绝**：与 D 重写后 + escape hatch 等价但多一字段表达同一概念，违反信息密度

### 2.5 Touchpoint estimate（若 D 重写 + E 重写实施）

| 改动点 | 文件 | LOC 估算 |
|---|---|---|
| 新加 `inherit_sandbox` + `allow_unrestricted_mapping` 字段（MCP schema + JSDoc） | `agent-deck-mcp/tools/schemas.ts:444-456` (SpawnSessionArgs) + `:483-504` (SpawnSessionResult `warnings: string[]`) + `:252-363` (HAND_OFF_SESSION_SCHEMA) | +25 |
| spawn handler 加映射逻辑 + warnings emit | `spawn.ts:131-135` + ok return 加 warnings 字段 | +25 |
| **hand_off_session handler 同款**（**真实文件 `hand-off-session.ts:281-303`**，非 `hand-off-session-impl.ts`） | `hand-off-session.ts:281-303` | +15 |
| 单测覆盖 4 种跨 adapter 矩阵 × 3 档 inherit_sandbox 值 | `__tests__/spawn-cross-adapter-sandbox.test.ts`（新建）+ `__tests__/spawn-guards.test.ts`（扩） | +80 |
| hand-off passthrough 单测 | `__tests__/hand-off-session.handler-cwd-generic.test.ts` 扩 | +30 |
| 文档（本 RFC + plan changelog 引用） | — | — |
| **合计** | — | **~+175** |

> R1 反馈：原版 §2.5 误把 hand-off 真实组装点写成 `hand-off-session-impl.ts`（仅解析 plan/prompt），实际 sandbox 字段透传在 `hand-off-session.ts:281-303`。SpawnSessionResult / HandOffSessionResult interface 都需加 `warnings?: string[]` 字段。

### 2.6 实施代价 / 风险

- **caller migration**:已有 caller 不改(默认行为不变);仅新场景显式传字段
- **映射 lossy 仍存在**(D 用户显式同意 lossy)
- **测试覆盖矩阵小**:4 种(claude→codex / codex→claude × inherit true/false × 4 个 sandbox 值)≈ 16 case,可参数化

### 2.7 Test plan

- 单测:`__tests__/spawn-cross-adapter-sandbox.test.ts` 参数化 16 case
- 集成:复跑 `__tests__/hand-off-session.handler-cwd-generic.test.ts` 验证 hand-off 路径同款
- regression:typecheck + 全单测一遍

### 2.8 迁移路线（若 D 重写 + E 重写落地）

1. **Step 1**：`schemas.ts` 加 `inherit_sandbox`（string enum）+ `allow_unrestricted_mapping` (bool) 字段到 SpawnSessionArgs / HAND_OFF_SESSION_SCHEMA + `warnings?: string[]` 到 SpawnSessionResult / HandOffSessionResult
2. **Step 2**：spawn handler 实装 string enum 映射（仅安全方向） + warnings 字段填充 + emit message 到 lead session 双发
3. **Step 3**：`hand-off-session.ts:281-303` 同步 sandbox 字段透传逻辑（与 spawn handler 字面镜像）
4. **Step 4**：单测 + 集成 + 文档
5. **Step 5**：typecheck + 异构对抗 review

---

## Chapter 3 — Scheduler 命名 convention

### 3.1 状态实证

#### 3.1.1 grep `class.*Scheduler` 命中的 class(全仓只 2 个)

| class | 文件 | 职责 |
|---|---|---|
| `LifecycleScheduler` | `src/main/session/lifecycle-scheduler.ts:30` | session lifecycle (active → dormant → closed) 状态机 + 周期性扫描 |
| `TeamLifecycleScheduler` | `src/main/teams/team-lifecycle-scheduler.ts:42` | team lifecycle (active → archived) + 孤儿成员清理 |

**结论**:全仓**只 2 个 Scheduler class**,命名已经一致(都是 `<Concept>LifecycleScheduler` / `<Concept>Scheduler` 后缀,文件名 kebab-case `<concept>-lifecycle-scheduler.ts`,class CamelCase)。

REVIEW_37 R1 finding F2 的实际触发面**比 plan 假设小** — reviewer-claude 自降级 INFO 是合理的。

#### 3.1.2 「Scheduler」范围定义（R1 reviewer-codex 反馈）

R1 reviewer-codex 指出「无遗漏 Scheduler-like 类」结论不成立 — 实证存在 `Summarizer` (`src/main/session/summarizer/index.ts:28` 含 `start/stop/setIntervalMs/setInterval`) 和 `UniversalMessageWatcher` (`src/main/teams/universal-message-watcher/index.ts:119` 含 `setInterval/stop`) 这类带 `start/stop + setInterval` 的后台调度器，但不叫 Scheduler。本 RFC 必须先定义「Scheduler」范围。

**本 RFC 的 Scheduler 定义**（lifecycle 状态机类）：
- 周期性扫描既有 entity 集合（session / team），按状态机规则迁移 lifecycle（active → dormant / archived / closed）
- 不创建新 entity，仅推 entity 状态
- 命名后缀 `Scheduler` 适用

**不属本 RFC 范围的「Scheduler-like」后台周期任务**（如 Summarizer / UniversalMessageWatcher）：
- 周期性触发 side-effect（生成摘要 / dispatch 消息 / poll 外部源）
- 命名按其语义（`Summarizer` / `Watcher` / `Poller` / `Dispatcher`），不强制 `Scheduler` 后缀
- 但可借鉴本 RFC §3.3.4 周期 settings 模式（统一 `setIntervalMs` setter）

`grep Scheduler` 在 `src/main` 命中 7 文件（仅含 lifecycle 状态机类引用）：

| 文件 | 性质 |
|---|---|
| `src/main/session/lifecycle-scheduler.ts` | Scheduler class 定义 |
| `src/main/teams/team-lifecycle-scheduler.ts` | Scheduler class 定义 |
| `src/main/teams/__tests__/team-lifecycle-scheduler.test.ts` | 测试 |
| `src/main/store/session-repo/lifecycle.ts` | 引用 LifecycleScheduler |
| `src/main/session/manager.ts` | 引用 LifecycleScheduler |
| `src/main/ipc/settings.ts` | 引用 LifecycleScheduler（改 settings 时通知 scheduler 周期变化） |
| `src/main/index.ts` | 启动时实例化两个 scheduler |

**结论**：在本 RFC 定义的「Scheduler = lifecycle 状态机」范围内，无遗漏类。Summarizer / UniversalMessageWatcher 等后台周期任务在范围外，命名不强制本 RFC convention。

### 3.2 动机

1. **新加 scheduler 时按 convention**:让命名风格自动一致,无需 review 阶段反复指出
2. **既有不重命名**:重命名 2 个 class 涉及 grep 替换 + 测试 + 单测 fixture 更新,**收益小风险大**(reviewer-claude 自降级 INFO 已 ack)
3. **文档化**:本 RFC Chapter 3 作为新加 scheduler 时的引用基准,commit message 可引用

### 3.3 命名规则建议

#### 3.3.1 class 命名

- **后缀**:`Scheduler`(若 lifecycle 类则 `LifecycleScheduler`)
- **形式**:CamelCase
- **前缀**:概念域(Session / Team / Summarizer / Baton 等)

✅ 推荐:`SessionLifecycleScheduler` / `TeamLifecycleScheduler` / `SummarizerScheduler` / `BatonExpirationScheduler`
❌ 反例:`LifeScheduler`(语义模糊) / `Sched`(缩写) / `SessionScheduler`(无概念区分)

> 例外:既有 `LifecycleScheduler` 当前缺前缀 — 严格按 convention 应是 `SessionLifecycleScheduler`。但 R37 R1 reviewer-claude 自降级 INFO 已 ack 不重命名;新加 scheduler 走完整命名即可。

#### 3.3.2 文件命名

- **kebab-case**:`<concept>-<purpose>-scheduler.ts`
- **目录**:放对应 domain 子目录(session 类放 `src/main/session/`,team 类放 `src/main/teams/`)

✅ 推荐:`src/main/session/lifecycle-scheduler.ts` / `src/main/teams/team-lifecycle-scheduler.ts`
✅ 推荐(新):`src/main/session/baton-expiration-scheduler.ts`
❌ 反例:`src/main/scheduler.ts`(无 domain 归类)

#### 3.3.3 实例化 + 单例 pattern

参考既有 pattern:`src/main/index.ts` 启动时实例化 + `getX()` / `setX()` 暴露(见项目 CLAUDE.md「主进程模块通信 / IPC 边界」节)。

```ts
// scheduler 模块
let _scheduler: XScheduler | null = null;
export function setXScheduler(s: XScheduler) { _scheduler = s; }
export function getXScheduler(): XScheduler | null { return _scheduler; }

// src/main/index.ts 启动:
const scheduler = new XScheduler({ /* ... */ });
setXScheduler(scheduler);
```

#### 3.3.4 周期性 settings 配置（双类约定）

R1 reviewer-codex 反馈：现有 `LifecycleScheduler` 没有 `setTickInterval`，settings 只热更新阈值；真正有 interval setter 的是 `Summarizer.setIntervalMs` (`src/main/session/summarizer/index.ts:97-115`)。本 RFC §3.3.4 修正为两类约定：

**类 1：Lifecycle scheduler（本 RFC §3.3.1 定义范围内）**
- 周期固定（应用启动时设一次），settings 热更新仅调**阈值**（如 `dormantAfterMs` / `closedAfterMs`）
- settings 字段命名：`<concept>DormantAfterMs` / `<concept>ClosedAfterMs` 等阈值字段
- ipc/settings.ts dispatch：`if (key === 'xDormantAfterMs') getXScheduler()?.setDormantThreshold(value)`

**类 2：周期可调后台任务（Scheduler 范围外，如 Summarizer / Watcher）**
- 周期可热更新，提供 `setIntervalMs(ms: number)` setter 重启 setInterval
- settings 字段命名：`<concept>IntervalMs`（如 `summaryIntervalMs`）
- ipc/settings.ts dispatch：`if (key === 'xIntervalMs') getX()?.setIntervalMs(value)`
- 命名 setter 统一 `setIntervalMs`，不要凭空引入 `setTickInterval` / `setPeriodMs` 等变体

参考既有：`Summarizer.setIntervalMs` (summarizer/index.ts:97-115) + `LifecycleScheduler` settings 热更新阈值 (lifecycle-scheduler.ts:48-50 + ipc/settings.ts:43-50, 151-156)。

### 3.4 推荐 — 待对抗 review 后定

**lead 倾向**(暂定,等 R1 review 反驳):

- **convention 文档化 推 ✅ 接受**:本 RFC Chapter 3 作为命名基准,新加 scheduler 时 commit message 引用本 RFC
- **既有 `LifecycleScheduler` 重命名为 `SessionLifecycleScheduler` 推 ❌ 拒绝**:reviewer-claude 自降级 INFO 已 ack 不做(成本 > 收益,且 grep 替换 + 测试 fixture 改动)
- **新加守门** 推 ✅ 接受:加新 scheduler 时若 reviewer 发现命名不符 convention,引用本 RFC Chapter 3 要求改

### 3.5 Touchpoint estimate

| 场景 | 改动点 | LOC 估算 |
|---|---|---|
| 既有 2 scheduler 不动 | — | 0 |
| 加新 scheduler(假设场景) | 新文件 + ipc/settings.ts dispatch + index.ts 启动 + setter / getter | ~150 / scheduler |
| 本 RFC 引用 | commit message 引用 / 顺手注释 | 0(机械) |
| **合计(本 RFC 落地)** | — | **0**(仅文档) |

### 3.6 实施代价 / 风险

- **0 代码改动**:本 RFC Chapter 3 仅 convention 文档,既有 2 scheduler 不动
- **后续守门成本**:新加 scheduler 时 reviewer 引用本 RFC,review cost 极小
- **风险**:几乎无 — 不实施代码改动

### 3.7 Test plan

- 无单测(仅 convention 文档)
- 守门:加新 scheduler 时单测 fixture 命名按 convention,review 引用本 RFC

### 3.8 迁移路线

无迁移 — 既有不动,新加按 convention。

---

## 后续 Phase 推进路线

按 plan §步骤 checklist:

| Phase | Step | 状态 |
|---|---|---|
| 1 | 1.1 Chapter 1 outline | ✅ 完成（commit 5780b93） |
| 1 | 1.2 Chapter 2 outline | ✅ 完成（commit 5780b93） |
| 1 | 1.3 Chapter 3 outline | ✅ 完成（commit 5780b93） |
| 2 | 2.1 spawn R1 reviewer pair（team `arch-design-rfc-r1`） | ✅ 完成 |
| 2 | 2.2 收 reply 三态裁决 | ✅ 完成 |
| 3 | 3.1 RFC 修订按 R1 反馈 | ✅ 完成（本 commit） |
| 3 | 3.2 用户 sign-off 每章决策 | ⬜ 待 |
| 4 | 4.1 Chapter 1 stub plan | ⬜ 待 |
| 4 | 4.2 Chapter 2 stub plan | ⬜ 待 |
| 4 | 4.3 Chapter 3 不需 plan | — |
| 5 | 5.1 RFC 归档（已在 docs/） | — |
| 5 | 5.2 REVIEW_X.md（可选） | ⬜ 待 |
| 5 | 5.3 CHANGELOG_X.md + plans/INDEX.md | ⬜ 待 |
| 5 | 5.4 archive_plan | ⬜ 待 |
