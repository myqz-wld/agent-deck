/**
 * useLastSessionDefaults — 新建会话类对话框的「上次选项」跨 mount 记忆
 * (plan pending-tab-resume-and-new-session-default-20260602 §D2)。
 *
 * 两个入口（NewSessionDialog 顶部新增按钮、ResolveInNewSessionDialog issue 详情起）
 * 共享同一组记忆：用户在 A 弹窗选了「plan + strict」，关掉后再开 B 弹窗默认还是「plan + strict」。
 * Claude Code 桥接层冷启动默认 permissionMode = bypassPermissions；用户改过后以内存记忆为准。
 *
 * **范围**：
 * - 跨 mount 持久（同一 session 内 React 重渲染 / dialog 关闭重开都不丢）
 * - 跨重启**不**持久（不写 localStorage、不走 AppSettings —— 用户明确要求「自动记住上次选的」
 *   不需要 settings 默认值；下一次开会话重置也符合 issue 解决场景的「每次重新审视」语义）
 * - 跨 adapter 隔离（claude-code / deepseek-claude-code / codex-cli 各自记忆）
 *
 * **实现**：
 * - 模块顶层 `let` 存 `Record<adapter, Defaults>`，组件 unmount 不清。`useRef` 跨实例会丢，
 *   普通 module-level `let` 才稳。
 * - `getLastAdapter()` / `setLastAdapter(adapter)` 记住上次选择的 adapter，让会被 unmount
 *   的 issue 解决弹窗重开后也沿用用户选择。
 * - `getLastDefaults(adapter)` 读（model / thinking 各 adapter 都记；sandbox 字段按 adapter 收口）
 * - `setLastDefaults(adapter, patch)` 写（merge）
 *
 * **adapter 收口**：通过 `as AdapterId` 强制窄化（sandbox-options.ts 字面量），非法 adapter key
 * 不进 store（提早抛错比静默丢更安全）。
 */
import type {
  ClaudeSandboxChoice,
  CodexSandboxChoice,
  PermissionModeChoice,
} from '@renderer/lib/sandbox-options';
import type { SessionThinkingLevel } from '@shared/session-metadata';
import type { AdapterSessionMode } from '@shared/types';

type AdapterId = 'claude-code' | 'deepseek-claude-code' | 'codex-cli' | 'grok-build';

type Defaults = {
  permissionMode?: PermissionModeChoice;
  sessionMode?: AdapterSessionMode;
  codexSandbox?: CodexSandboxChoice;
  claudeCodeSandbox?: ClaudeSandboxChoice;
  /** 自由文本；空串表示明确恢复 provider 默认模型。 */
  model?: string;
  /** 空串表示明确恢复 provider 默认思考程度。 */
  thinking?: SessionThinkingLevel | '';
};

const store: Record<AdapterId, Defaults> = {
  'claude-code': { permissionMode: 'bypassPermissions' },
  'deepseek-claude-code': { permissionMode: 'bypassPermissions' },
  'codex-cli': {},
  'grok-build': { sessionMode: 'default' },
};
let lastAdapter: AdapterId = 'claude-code';

function isAdapterId(s: string): s is AdapterId {
  return (
    s === 'claude-code' ||
    s === 'deepseek-claude-code' ||
    s === 'codex-cli' ||
    s === 'grok-build'
  );
}

export function getLastAdapter(): AdapterId {
  return lastAdapter;
}

export function setLastAdapter(adapter: string): void {
  if (!isAdapterId(adapter)) return;
  lastAdapter = adapter;
}

/**
 * 读本 adapter 上次记的默认值。返回的 shape 故意只含本 adapter 的字段：
 * - claude-code/deepseek adapter → 可能含 permissionMode + claudeCodeSandbox + model/thinking
 *   （不带 codexSandbox）
 * - codex-cli adapter → 可能含 codexSandbox + model/thinking（不带 permissionMode /
 *   claudeCodeSandbox）
 * 避免 caller 误读跨 adapter 字段。
 */
export function getLastDefaults(adapter: string): Defaults {
  if (!isAdapterId(adapter)) return {};
  const cur = store[adapter];
  // 浅拷贝防 caller mutation 污染 store
  return { ...cur };
}

/**
 * 写本 adapter 的 last-used。patch 任意字段可空，merge 进 store。
 * - model / thinking：三个 adapter 都落到各自桶
 * - claude-code/deepseek-claude-code: permissionMode / claudeCodeSandbox 落库；codexSandbox 忽略
 * - codex-cli: codexSandbox 落库；permissionMode / claudeCodeSandbox 忽略
 * 不在主进程跑、纯 renderer 内存 store —— 任何值传错也是本地错，UI 下一次 reset 自然恢复。
 */
export function setLastDefaults(adapter: string, patch: Partial<Defaults>): void {
  if (!isAdapterId(adapter)) return;
  if (adapter === 'claude-code' || adapter === 'deepseek-claude-code') {
    const next: Defaults = { ...store[adapter] };
    if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
    if (patch.claudeCodeSandbox !== undefined) next.claudeCodeSandbox = patch.claudeCodeSandbox;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.thinking !== undefined) next.thinking = patch.thinking;
    // 故意忽略 patch.codexSandbox —— 不允许跨 adapter 串味
    store[adapter] = next;
  } else if (adapter === 'codex-cli') {
    const next: Defaults = { ...store['codex-cli'] };
    if (patch.codexSandbox !== undefined) next.codexSandbox = patch.codexSandbox;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.thinking !== undefined) next.thinking = patch.thinking;
    store['codex-cli'] = next;
  } else {
    const next: Defaults = { ...store['grok-build'] };
    if (patch.sessionMode !== undefined) next.sessionMode = patch.sessionMode;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.thinking !== undefined) next.thinking = patch.thinking;
    store['grok-build'] = next;
  }
}
