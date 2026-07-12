import Store from 'electron-store';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  DEFAULT_CONTINUATION_CHECKPOINT_THINKING,
  MAX_CONTINUATION_RAW_RETENTION_TOKENS,
  MIN_CONTINUATION_RAW_RETENTION_TOKENS,
  type AppSettings,
  type ContinuationCheckpointProvider,
} from '@shared/types';
import { isClaudeThinkingLevel, isCodexThinkingLevel } from '@shared/session-metadata';
import log from '@main/utils/logger';

const logger = log.scope('settings-store');

// electron-store v8.2.0 继承自 conf v10.2.0 的 ESM 类（含 `#private`），
// TS 推断子类时丢失了 store/get/set 等成员。这里用接口断言显式补回。
// （REVIEW_92：原注释误写 "v10 / conf v14"，实测依赖是 electron-store@8.2.0 + conf@10.2.0，
//  与下方 F1 注释 line 71/73 一致。）
interface StoreApi<T> {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  delete<K extends keyof T>(key: K): void;
  has<K extends keyof T>(key: K): boolean;
}

/**
 * 已被移除的字段名。每次启动时从持久化文件里清理一次，
 * 避免历史 install 留下的孤儿字段（如 anthropicApiKey）越积越多。
 */
const REMOVED_KEYS: readonly string[] = [
  'anthropicApiKey',
  // R3.E6 (PR-B) 硬切删除：agent teams 老 backend 下线
  // —— inbox 协议 / Claude Code experimental teams flag / autoApprove 三档 全废
  'agentTeamsEnabled',
  'autoApproveTeammateMode',
  // CHANGELOG_100 / plan mcp-tool-simplify-20260514：删 wait_reply tool 联动删 idle 阈值
  'mcpWaitReplyIdleQuietMs',
  // CHANGELOG_68：R3.E12 一次性「即将硬切」弹窗 + LegacyTeamExportSection 整体下线
  // —— PR-B 硬切已上线 + R4 已实施，备份窗口期已过，相关 IPC / dialog / settings 字段全废
  'r3LegacyExportNoticeAcked',
  // Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）：透明 / 置顶解耦
  // 重命名为 windowTransparent + 解耦语义。一次性 migration 在 ensure() 内做（旧值 →
  // 新字段），随后 REMOVED_KEYS 自动清孤儿字段，老用户偏好不丢。
  'transparentWhenPinned',
  // plan task-mcp-merge-into-agent-deck-mcp-20260521：5 个 task tool 合并入
  // agent-deck-mcp namespace 后删 enableTaskManager 独立 toggle，task tools 跟随
  // enableAgentDeckMcp 开关。smart migration（见 ensure() 内）守护老用户 ON 值不丢
  // 失能力 — raw enableTaskManager:true + raw 不含 enableAgentDeckMcp → 自动 set
  // enableAgentDeckMcp:true 后再 delete legacy（详 plan §D2 R1 F11 + R3-claude-MED-1）。
  'enableTaskManager',
  // Earlier releases retired the provider-specific Codex fields into summary* and the now-legacy
  // handOff* settings. They were never migrated automatically; the continuation migration below
  // starts from handOff* and deliberately does not resurrect these older orphan keys.
  'codexSummaryModel',
  'codexHandOffModel',
  // plan resume-inject-raw-messages-20260601 §不变量 7：删 autoSummariseOnFallback toggle。
  // UI toggle 早删（plan prancy-forging-penguin），字段保留 default:true 当孤儿 zombie；本 plan
  // 把 fallback 路径改成无条件注入历史（DB 有历史就注 — 删死分支 `if (!autoSummariseOnFallback)`），
  // 字段进 REMOVED_KEYS 清历史持久化孤儿。
  'autoSummariseOnFallback',
  // 2026-06-15：Claude bundled plugin 的 skills / agents 注入拆成两个独立开关。
  // ensure() 内先把 legacy 值迁移到 injectAgentDeckClaude{Skills,Agents}，随后清旧字段。
  'injectAgentDeckPlugin',
  // Unified Continuation Context replaces the hand-off-only generator names and count-based
  // retention control. Migration runs before this cleanup list.
  'handOffProvider',
  'handOffModel',
  'handOffReasoning',
  'resumeRecentMessagesCount',
  '__resumeRecentMessagesDefault20260710Done',
];

const CONTINUATION_PROVIDERS: readonly ContinuationCheckpointProvider[] = [
  'claude',
  'deepseek',
  'codex',
];

interface LooseStore {
  set(key: string, value: unknown): void;
}

function validContinuationProvider(value: unknown): value is ContinuationCheckpointProvider {
  return CONTINUATION_PROVIDERS.includes(value as ContinuationCheckpointProvider);
}

function migratedThinking(
  provider: ContinuationCheckpointProvider,
  value: unknown,
  allowLegacyCoercion: boolean,
): AppSettings['continuationCheckpointThinking'] {
  // Codex no longer accepts minimal. Preserve a user's nearest lower-cost choice rather than
  // falling through to the generator default (high).
  if (value === 'minimal') return 'low';
  if (provider === 'codex') {
    return isCodexThinkingLevel(value) ? value : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
  }
  if (allowLegacyCoercion && value === 'ultra') return 'max';
  return isClaudeThinkingLevel(value)
    ? value
    : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
}

/** Presence-aware one-time migration; persisted new keys always win over legacy values. */
function migrateContinuationSettings(
  persistedRaw: Readonly<Record<string, unknown>>,
  target: LooseStore,
): void {
  const providerSource = 'continuationCheckpointProvider' in persistedRaw
    ? persistedRaw.continuationCheckpointProvider
    : persistedRaw.handOffProvider;
  const hasProviderSource =
    'continuationCheckpointProvider' in persistedRaw || 'handOffProvider' in persistedRaw;
  const provider = validContinuationProvider(providerSource)
    ? providerSource
    : DEFAULT_SETTINGS.continuationCheckpointProvider;
  if (
    hasProviderSource &&
    (!('continuationCheckpointProvider' in persistedRaw) || providerSource !== provider)
  ) {
    target.set('continuationCheckpointProvider', provider);
  }

  const modelSource = 'continuationCheckpointModel' in persistedRaw
    ? persistedRaw.continuationCheckpointModel
    : persistedRaw.handOffModel;
  const hasModelSource =
    'continuationCheckpointModel' in persistedRaw || 'handOffModel' in persistedRaw;
  const model =
    typeof modelSource === 'string' && modelSource.length <= 256
      ? modelSource
      : DEFAULT_SETTINGS.continuationCheckpointModel;
  if (
    hasModelSource &&
    (!('continuationCheckpointModel' in persistedRaw) || modelSource !== model)
  ) {
    target.set('continuationCheckpointModel', model);
  }

  const thinkingSource = 'continuationCheckpointThinking' in persistedRaw
    ? persistedRaw.continuationCheckpointThinking
    : persistedRaw.handOffReasoning;
  const hasThinkingSource =
    'continuationCheckpointThinking' in persistedRaw || 'handOffReasoning' in persistedRaw;
  const thinking = migratedThinking(
    provider,
    thinkingSource,
    !('continuationCheckpointThinking' in persistedRaw) && 'handOffReasoning' in persistedRaw,
  );
  if (
    hasThinkingSource &&
    (!('continuationCheckpointThinking' in persistedRaw) || thinkingSource !== thinking)
  ) {
    target.set('continuationCheckpointThinking', thinking);
  }

  if ('continuationRawRetentionTokens' in persistedRaw) {
    const rawTokens = persistedRaw.continuationRawRetentionTokens;
    if (
      !Number.isSafeInteger(rawTokens) ||
      (rawTokens as number) < MIN_CONTINUATION_RAW_RETENTION_TOKENS ||
      (rawTokens as number) > MAX_CONTINUATION_RAW_RETENTION_TOKENS
    ) {
      target.set(
        'continuationRawRetentionTokens',
        DEFAULT_SETTINGS.continuationRawRetentionTokens,
      );
    }
  }
}

function migrateRemovedCodexMinimalGeneratorSettings(
  persistedRaw: Readonly<Record<string, unknown>>,
  target: LooseStore,
): void {
  if (persistedRaw.summaryReasoning === 'minimal') {
    target.set('summaryReasoning', 'low');
    logger.info('[settings] migrated summaryReasoning minimal → low (Codex effort removal)');
  }
}

let store: (Store<AppSettings> & StoreApi<AppSettings>) | null = null;

function ensure(): Store<AppSettings> & StoreApi<AppSettings> {
  if (!store) {
    // **F-R2-D 设计假设**（deep-review-changelog146-20260524 R2 claude LOW-4）：
    // 本函数不包 try/catch，所有 migration step / token 生成 / REMOVED_KEYS delete loop
    // 都依赖以下不变量：
    //   1) probe Store / real Store 构造 (fs read) 由 conf v10.2.0 内部 swallow 大多数
    //      ENOENT / 权限错（首次启动走 createPlainObject() fallback line 286）
    //   2) store.set / store.delete 同步写 fs：conf@10.2.0 `_write` 仅对 EXDEV 兜底回退
    //      非原子写，**其余写错误（ENOSPC / EACCES 等）直接 rethrow**（REVIEW_92 codex
    //      实证 conf dist _write line 374-385）。即本不变量真正依赖的是「常态磁盘可写时
    //      set/delete 不抛」，而非「conf 内部 swallow 一切」。极罕 IO 错仍会冒泡 → 见下方
    //      step (2) throw 半残分析。
    //   3) Migration step 全部同步 + 纯 JS 逻辑判定，不撞 IO 抛错
    // 一旦上述不变量被破坏（如 fs ENOSPC / 极罕 conf assert.deepEqual fail / 未来加 IO step），
    // step (2) 之后任一 step throw → `store` 全局变量已是非 null real Store 但 migration 半残
    // → 下次 ensure() `if (!store)` 短路返回半残 store → 用户偏好 / token 永久部分缺失。
    // 当前不修因为 (a) 极罕见 + (b) 加 try/catch 后回滚语义复杂（reset store=null 重试可能
    // 撞死循环）+ (c) bootstrap fail-fast 比半残 partial-recover 更明确。未来加 IO 类
    // migration 步必须重审本假设。
    //
    // F1 fix (deep-review-changelog146-20260524 R1 codex MED):
    // conf@10.2.0 (electron-store@8.2.0 父类) 构造时 line 131-138 在传入 defaults 后
    // 把 `Object.assign({}, defaults, fileStore)` merged 结果 _write 回 fs（assert.deepEqual
    // fails on any default key missing in fileStore）。后续 store.store getter (line 274) 走
    // fs.readFileSync 拿到 merged 版本 — 所有 `!('newKey' in raw)` 形态的 migration 第二次启动
    // 起永远短路（newKey 已被 defaults 写回 fs），老用户偏好静默丢失。
    //
    // 影响面（DEFAULT_SETTINGS 含的 key）：
    // - transparentWhenPinned → windowTransparent migration（windowTransparent: true 默认）
    // - enableTaskManager → enableAgentDeckMcp migration（enableAgentDeckMcp 默认值参与写回）
    //
    // 修法：构造 real store 前先开一个无 defaults 的 probe Store，snapshot fs 上**真实持久化的
    // raw**（probe 自己不传 defaults，conf 构造时 `if (options.defaults)` 跳过 → 不触发 merge
    // 写回）。后续所有 migration 判定一律基于 persistedRaw 而非 store.store。
    const probe = new Store<Record<string, unknown>>({
      name: 'agent-deck-settings',
    }) as { store: Record<string, unknown> };
    const persistedRaw: Record<string, unknown> = { ...probe.store };

    store = new Store<AppSettings>({
      name: 'agent-deck-settings',
      // conf/electron-store may retain and mutate the object supplied as defaults when set() is
      // called. Never hand it the exported process-wide constant: runtime fallback logic and tests
      // must not inherit a user's most recent setting through an aliased defaults object.
      defaults: structuredClone(DEFAULT_SETTINGS),
    }) as Store<AppSettings> & StoreApi<AppSettings>;

    // 清理已弃用字段（idempotent：再次启动时即便没有这些键也无副作用）
    const looseDelete = store as unknown as { delete: (k: string) => void };
    // Phase 5 Step 5.6 一次性 migration：transparentWhenPinned → windowTransparent。
    // 必须在 REMOVED_KEYS delete 循环之前做（delete 后旧值就拿不到了）。仅在用户从未
    // 设置过新字段且持有旧字段值时迁移；否则用户已经主动设了 windowTransparent 不动。
    if ('transparentWhenPinned' in persistedRaw && !('windowTransparent' in persistedRaw)) {
      const legacy = persistedRaw['transparentWhenPinned'];
      if (typeof legacy === 'boolean') {
        store.set('windowTransparent', legacy);
        logger.info(`[settings] migrated transparentWhenPinned=${legacy} → windowTransparent`);
      }
    }
    // plan remove-aider-generic-pty-adapters-20260520 Follow-up F2 一次性 migration：
    // CHANGELOG_125 P5 plan codex-handoff-team-alignment-20260518 升级 mcpMaxFanOutPerParent
    // 默认 5 → 10 / mcpSpawnRatePerMinute 默认 10 → 20，但已 persist user 老值不更新。
    // 检测 persisted 值正好等于老 default → 升级到新 default；user 显式选非 default 值
    // (7 / 15 等) → 保留 user 选择。
    //
    // **REVIEW_92（reviewer-claude MED + lead UI range 验证）**：这是 **value-migration**
    // （判定基于值且迁移目标就是同一 key），与 transparentWhenPinned/enableTaskManager 的
    // key-presence migration（迁移后 delete 旧 key 故天然一次性）不同 —— **必须显式 sentinel
    // gate 才能真一次性**。否则用户重启后在 UI 主动选回 5（fanOut min=1/max=20）或 10
    // （rate min=1/max=60）→ 下次启动 probe 读 fs=5/10 → migration RE-FIRE 静默压回 10/20
    // → 用户显式选择永久无法跨重启存活（AgentDeckMcpSection.tsx:107-120 两值均合法可选）。
    // 修法：loose 内部 sentinel `__valueUpliftMigrationDone`（不进 AppSettings / DEFAULT_SETTINGS /
    // UI），缺失才跑迁移块，跑完无条件置位。已迁移老用户（fs=10/20 无 sentinel）首次进来
    // no-op 后置位；当前停在 5/10 的用户最后被 uplift 一次后 sentinel 置位，此后 5/10 选择生效。
    const looseStore = store as unknown as {
      get: (k: string) => unknown;
      set: (k: string, v: unknown) => void;
      delete: (k: string) => void;
    };
    migrateContinuationSettings(persistedRaw, looseStore);
    migrateRemovedCodexMinimalGeneratorSettings(persistedRaw, looseStore);
    // 2026-07-11 generator defaults: periodic summaries low → medium; continuation checkpoints
    // medium → high. electron-store persists defaults as ordinary values, so exact old defaults
    // need a one-time value uplift for existing installs. The sentinel prevents a later explicit
    // user choice of low/medium from being rewritten again on restart.
    const GENERATOR_DEFAULTS_20260711_SENTINEL = '__generatorDefaults20260711Done';
    if (persistedRaw[GENERATOR_DEFAULTS_20260711_SENTINEL] !== true) {
      if (persistedRaw['summaryReasoning'] === 'low') {
        store.set('summaryReasoning', 'medium');
        logger.info('[settings] migrated summaryReasoning low → medium (2026-07-11 default uplift)');
      }
      if (persistedRaw['continuationCheckpointThinking'] === 'medium') {
        store.set('continuationCheckpointThinking', 'high');
        logger.info(
          '[settings] migrated continuationCheckpointThinking medium → high ' +
            '(2026-07-11 default uplift)',
        );
      }
      looseStore.set(GENERATOR_DEFAULTS_20260711_SENTINEL, true);
    }
    const VALUE_UPLIFT_SENTINEL = '__valueUpliftMigrationDone';
    if (persistedRaw[VALUE_UPLIFT_SENTINEL] !== true) {
      if (persistedRaw['mcpMaxFanOutPerParent'] === 5) {
        store.set('mcpMaxFanOutPerParent', 10);
        logger.info('[settings] migrated mcpMaxFanOutPerParent 5 → 10 (default uplift, plan F2)');
      }
      if (persistedRaw['mcpSpawnRatePerMinute'] === 10) {
        store.set('mcpSpawnRatePerMinute', 20);
        logger.info('[settings] migrated mcpSpawnRatePerMinute 10 → 20 (default uplift, plan F2)');
      }
      // 无条件置位（即便本次未触发任一迁移）：fresh install / 已迁移老用户也标记完成，
      // 杜绝下次启动 re-fire。sentinel 是 loose 内部 key，不污染 AppSettings 类型面。
      // ⚠️ 扩展边界（REVIEW_92 reviewer-claude INFO）：本单一 bool sentinel 覆盖「当前同批
      // 引入的两个 value-uplift」。未来若**跨版本**新增第三个 value-migration，不可复用本
      // sentinel（已置位老用户会跳过新迁移）→ 需引入第二个 sentinel 或带版本号的 migration 标记。
      looseStore.set(VALUE_UPLIFT_SENTINEL, true);
    }
    // 2026-06-04 设置面板数值默认值升级。electron-store 会把 defaults 写回设置文件，
    // 所以旧安装里“用户没动过”的默认值也会以普通持久化值存在。这里沿用上方 value-uplift
    // sentinel 模式：只升级一次恰好等于旧默认的数值，之后用户手动改回旧值也能跨重启保留。
    // enableAgentDeckMcp 不进本轮 uplift：无法区分旧默认 false 与用户显式关闭；新安装走
    // DEFAULT_SETTINGS=true，legacy enableTaskManager 仍由下方 smart migration 处理。
    const SETTINGS_DEFAULTS_20260604_SENTINEL = '__settingsDefaults20260604Done';
    if (persistedRaw[SETTINGS_DEFAULTS_20260604_SENTINEL] !== true) {
      if (persistedRaw['activeWindowMs'] === 30 * 60 * 1000) {
        store.set('activeWindowMs', 60 * 60 * 1000);
        logger.info('[settings] migrated activeWindowMs 30min → 60min (2026-06-04 default uplift)');
      }
      if (persistedRaw['permissionTimeoutMs'] === 5 * 60 * 1000) {
        store.set('permissionTimeoutMs', 30 * 60 * 1000);
        logger.info(
          '[settings] migrated permissionTimeoutMs 5min → 30min (2026-06-04 default uplift)',
        );
      }
      if (persistedRaw['issueResolvedRetentionDays'] === 90) {
        store.set('issueResolvedRetentionDays', 30);
        logger.info(
          '[settings] migrated issueResolvedRetentionDays 90d → 30d (2026-06-04 default uplift)',
        );
      }
      looseStore.set(SETTINGS_DEFAULTS_20260604_SENTINEL, true);
    }
    // Claude Code sandbox 默认从 off 升到 workspace-write。单独 sentinel，不能复用上面的
    // 2026-06-04 数值默认 sentinel：已经跑过旧版本默认升级的用户也必须能收到本次迁移。
    const CLAUDE_SANDBOX_DEFAULT_20260604_SENTINEL = '__claudeSandboxDefault20260604Done';
    if (persistedRaw[CLAUDE_SANDBOX_DEFAULT_20260604_SENTINEL] !== true) {
      if (persistedRaw['claudeCodeSandbox'] === 'off') {
        store.set('claudeCodeSandbox', 'workspace-write');
        logger.info(
          '[settings] migrated claudeCodeSandbox off → workspace-write (2026-06-04 default uplift)',
        );
      }
      looseStore.set(CLAUDE_SANDBOX_DEFAULT_20260604_SENTINEL, true);
    }
    // plan task-mcp-merge-into-agent-deck-mcp-20260521 §D2 R1 F11 + R3-claude-MED-1:
    // smart migration 守护老用户 enableTaskManager:true 不丢失能力。在 REMOVED_KEYS
    // delete loop 之前 (line 74) 读 persistedRaw.enableTaskManager 决定是否 carry 到 enableAgentDeckMcp。
    //
    // 4 case 矩阵（详 plan §测试覆盖矩阵 settings-store migration 4 格断言）：
    // - persistedRaw enableTaskManager:true + persistedRaw 不含 enableAgentDeckMcp → set enableAgentDeckMcp:true
    //   + warn（保留老用户「task tools 可用」语义；5 个 task tool 已合入 agent-deck namespace）
    // - persistedRaw enableTaskManager:false + persistedRaw 不含 enableAgentDeckMcp → set enableAgentDeckMcp:false
    //   （保留老用户主动 OFF 表达「不想用」）
    // - persistedRaw 含 explicit enableAgentDeckMcp 值 → migration skip（用户决策优先）
    // - persistedRaw 全空（fresh install）→ migration no-op + 不打 warn（新用户路径不该看 warn 噪音）
    if ('enableTaskManager' in persistedRaw && !('enableAgentDeckMcp' in persistedRaw)) {
      if (persistedRaw['enableTaskManager'] === true) {
        store.set('enableAgentDeckMcp', true);
        logger.info(
          '[settings] migrated enableTaskManager=true → enableAgentDeckMcp=true (plan task-mcp-merge-into-agent-deck-mcp-20260521 §D2 R1 F11 — task tools 合并入 agent-deck namespace，保留老用户 ON 值不丢失能力)',
        );
      } else if (persistedRaw['enableTaskManager'] === false) {
        store.set('enableAgentDeckMcp', false);
        logger.info(
          '[settings] migrated enableTaskManager=false → enableAgentDeckMcp=false (preserve legacy explicit OFF)',
        );
      }
    }
    // 2026-06-15：原 `injectAgentDeckPlugin` 同时控制 Claude bundled skills + agents。
    // 新字段分离后，老用户显式关闭旧总开关时必须同时继承到两个新开关；如果用户已经
    // 持有任一新字段，则以新字段为准，只补缺失的一侧。
    if ('injectAgentDeckPlugin' in persistedRaw && typeof persistedRaw['injectAgentDeckPlugin'] === 'boolean') {
      const legacyPluginEnabled = persistedRaw['injectAgentDeckPlugin'];
      if (!('injectAgentDeckClaudeSkills' in persistedRaw)) {
        store.set('injectAgentDeckClaudeSkills', legacyPluginEnabled);
        logger.info(
          `[settings] migrated injectAgentDeckPlugin=${legacyPluginEnabled} → injectAgentDeckClaudeSkills=${legacyPluginEnabled}`,
        );
      }
      if (!('injectAgentDeckClaudeAgents' in persistedRaw)) {
        store.set('injectAgentDeckClaudeAgents', legacyPluginEnabled);
        logger.info(
          `[settings] migrated injectAgentDeckPlugin=${legacyPluginEnabled} → injectAgentDeckClaudeAgents=${legacyPluginEnabled}`,
        );
      }
    }
    for (const key of REMOVED_KEYS) {
      if (key in persistedRaw) {
        looseDelete.delete(key);
        logger.info(`[settings] removed legacy field "${key}"`);
      }
    }

    // 首次启动自动生成 HookServer Bearer token：32 字节随机 hex = 64 字符（256-bit）。
    // 足以抵御本地暴力枚举；持久化后保持稳定，避免已注入的 hook 命令因 token 变动失效。
    // **REVIEW_92（reviewer-codex LOW）**：校验从「length < 64」收紧为 canonical hex 格式
    // `^[0-9a-f]{64}$`。原 length-only 阈值会接受 64 个空格 / 64 个 `x` 等 malformed token
    // （app 自身生成路径不会产出，但配置被手工改坏 / 外部写入 malformed 时不自愈）。收紧后
    // 任何非 canonical token 自动重生成，与「32 字节随机 hex」注释契约一致。
    const isCanonicalToken = (v: unknown): v is string =>
      typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
    if (!isCanonicalToken(store.get('hookServerToken'))) {
      const fresh = randomBytes(32).toString('hex');
      store.set('hookServerToken', fresh);
      logger.info('[settings] generated new hookServerToken (random 32-byte hex = 64 chars)');
    }
    // R2 / B'0 ADR §5.2：MCP HTTP / stdio transport Bearer token 同模式生成。
    // 与 hookServerToken 独立 —— hook token 嵌进每个 CLI 子进程 spawn 命令泄漏面广，
    // mcp token 仅嵌进 codex `~/.codex/config.toml` mcp_servers 段 + Settings UI 显示
    // 给用户复制（外部 MCP client 用），泄漏面窄。一旦 hook token 泄漏，MCP 通道仍安全。
    if (!isCanonicalToken(store.get('mcpServerToken'))) {
      const fresh = randomBytes(32).toString('hex');
      store.set('mcpServerToken', fresh);
      logger.info('[settings] generated new mcpServerToken (random 32-byte hex = 64 chars)');
    }
  }
  return store;
}

export const settingsStore = {
  getAll(): AppSettings {
    // 剔除 `__` 前缀 loose 内部 key（如 __valueUpliftMigrationDone migration sentinel，
    // REVIEW_92）—— 它们持久化在同一 conf 文件但不属 AppSettings 类型面，不应流到 IPC /
    // renderer。filter 后再 spread，杜绝内部 marker 泄漏到 SettingsGet 响应。
    const raw = ensure().store as unknown as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('__')) cleaned[k] = v;
    }
    return { ...DEFAULT_SETTINGS, ...(cleaned as Partial<AppSettings>) };
  },
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return ensure().get(key);
  },
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    ensure().set(key, value);
  },
  patch(patch: Partial<AppSettings>): AppSettings {
    const current = this.getAll();
    const next = { ...current, ...patch };
    const s = ensure();
    for (const [k, v] of Object.entries(patch)) {
      s.set(k as keyof AppSettings, v as AppSettings[keyof AppSettings]);
    }
    return next;
  },
};
