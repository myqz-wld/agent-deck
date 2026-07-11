// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.9 拆分(facade):adapter type declaration 8 export 单源 re-export。
// 子模块 entity 域严格划分:
// - ./types/adapter-context  — AdapterContext + PermissionMode (基础)
// - ./types/create-session-opts  — ClaudeCreateOpts / CodexCreateOpts /
//   CreateSessionOptions / CreateSessionOptionsRaw (4 个 createSession opts)
// - ./types/capabilities  — AdapterCapabilities
// - ./types/agent-adapter  — AgentAdapter 主接口
// - ./types/fork-session  — provider-neutral native fork contract
//
// caller 端 import path 不动:全 byte-identical re-export 保 63 caller import 零改。
// ────────────────────────────────────────────────────────────────────────────

export type { AdapterContext, PermissionMode } from './types/adapter-context';
export type {
  ClaudeCodeEffortLevel,
  ClaudeCreateOpts,
  CodexModelReasoningEffort,
  CodexCreateOpts,
  CreateSessionOptions,
  CreateSessionOptionsRaw,
  InitialSessionRegistration,
} from './types/create-session-opts';
export type { AdapterCapabilities } from './types/capabilities';
export type {
  CreateForkedSession,
  ForkedSessionHandle,
  ForkSessionSource,
  ValidateForkSession,
} from './types/fork-session';
export type { AgentAdapter } from './types/agent-adapter';
