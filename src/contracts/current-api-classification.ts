import { IpcInvoke } from '@shared/ipc-channels';

export type CurrentApiMethod = keyof typeof IpcInvoke;

export interface CurrentApiClassification {
  executionOwner: 'authoritative-core' | 'client-host' | 'split';
  sshMigration: 'client-adapter' | 'core-protocol' | 'split-adapter';
  feishu: 'none' | 'session-console';
}

const clientHost = {
  executionOwner: 'client-host',
  sshMigration: 'client-adapter',
  feishu: 'none',
} as const satisfies CurrentApiClassification;

const core = {
  executionOwner: 'authoritative-core',
  sshMigration: 'core-protocol',
  feishu: 'none',
} as const satisfies CurrentApiClassification;

const coreFeishu = {
  executionOwner: 'authoritative-core',
  sshMigration: 'core-protocol',
  feishu: 'session-console',
} as const satisfies CurrentApiClassification;

const split = {
  executionOwner: 'split',
  sshMigration: 'split-adapter',
  feishu: 'none',
} as const satisfies CurrentApiClassification;

/**
 * Migration ownership for every existing renderer → preload invoke channel.
 *
 * Keeping this exhaustive prevents a new local IPC method from acquiring accidental remote or
 * Feishu semantics. It is a migration ledger, not the final transport method registry.
 */
export const CURRENT_API_CLASSIFICATION = {
  AppGetVersion: clientHost,
  WindowSetAlwaysOnTop: clientHost,
  WindowSetIgnoreMouse: clientHost,
  WindowMinimize: clientHost,
  WindowToggleCompact: clientHost,

  SessionList: coreFeishu,
  SessionListHistory: coreFeishu,
  SessionGet: coreFeishu,
  SessionTakePendingFocus: clientHost,
  SessionArchive: core,
  SessionUnarchive: core,
  SessionDelete: core,
  SessionReactivate: core,
  SessionSetPinned: core,
  SessionListEvents: coreFeishu,
  SessionListFileChangePage: core,
  SessionGetFileChange: core,
  SessionGetFileFinalDiff: core,
  SessionGetGitBranch: core,
  SessionListSummaries: core,
  SessionLatestSummaries: core,
  SessionListTasks: core,
  SessionHandOffPrepare: core,
  SessionHandOffCommit: core,
  SessionHandOffCancel: core,

  HookInstall: core,
  HookUninstall: core,
  HookStatus: core,
  SettingsGet: split,
  SettingsSet: split,

  AdapterCreateSession: coreFeishu,
  AdapterSessionCreationDefaults: coreFeishu,
  AdapterInterrupt: coreFeishu,
  AdapterSendMessage: coreFeishu,
  AdapterListPendingOutgoing: core,
  AdapterLoadPendingOutgoingAttachment: core,
  AdapterDeletePendingOutgoing: core,
  AdapterSteerTurn: coreFeishu,
  AdapterRespondPermission: coreFeishu,
  AdapterRespondAskUserQuestion: coreFeishu,
  AdapterRespondExitPlanMode: coreFeishu,
  AdapterRespondDiffReview: coreFeishu,
  PlanReviewStartDeepReview: core,
  PlanReviewAskDeepReview: core,
  PlanReviewGenerateFeedback: core,
  AdapterSetPermissionMode: coreFeishu,
  AdapterSetSessionMode: coreFeishu,
  AdapterSetSessionModelOptions: coreFeishu,
  AdapterSetCodexApprovalPolicy: coreFeishu,
  AdapterSetCodexSandbox: coreFeishu,
  AdapterRestartWithClaudeCodeSandbox: coreFeishu,
  AdapterRestartWithGrokSandbox: coreFeishu,
  AdapterListPending: coreFeishu,
  AdapterListPendingAll: coreFeishu,
  AdapterList: coreFeishu,

  DialogChooseDirectory: clientHost,
  DialogChooseSoundFile: clientHost,
  DialogChooseExecutable: clientHost,
  AppPlayTestSound: clientHost,
  AppShowTestNotification: clientHost,
  DialogConfirm: clientHost,

  PermissionScanCwd: core,
  PermissionOpenFile: split,
  PermissionScanCodex: core,
  PermissionOpenCodexFile: split,
  ImageLoadBlob: core,
  UploadedImageLoad: split,

  ClaudeMdGet: core,
  ClaudeMdSave: core,
  ClaudeMdReset: core,
  CodexAgentsMdGet: core,
  CodexAgentsMdSave: core,
  CodexAgentsMdReset: core,
  GrokAgentsMdGet: core,
  GrokAgentsMdSave: core,
  GrokAgentsMdReset: core,
  GrokAuthProbe: core,
  SummarizerLastErrors: core,

  IssuesList: core,
  IssuesGet: core,
  IssuesUpdate: core,
  IssuesSoftDelete: core,
  IssuesUndelete: core,
  IssuesResolveInNewSession: core,

  TokenUsageRates: core,
  TokenUsageTopToday: core,
  TokenUsageDaily: core,
  ProviderUsageSnapshot: core,

  AgentDeckTeamList: core,
  AgentDeckTeamGet: core,
  AgentDeckTeamGetFull: core,
  AgentDeckTeamCreate: core,
  AgentDeckTeamArchive: core,
  AgentDeckTeamUnarchive: core,
  AgentDeckTeamAddMember: core,
  AgentDeckTeamRemoveMember: core,
  AgentDeckTeamShutdownAllTeammates: core,
  AgentDeckTeamSendMessage: core,
  AgentDeckMessageListByTeam: core,
  AgentDeckMessageListBySession: core,
  AgentDeckMessageCancel: core,
  TaskListByTeam: core,

  AssetsListBundled: core,
  AssetsListUser: core,
  AssetsGetContent: core,
  AssetsRevealInFolder: split,
  AssetsSaveBundledAgentRuntime: core,
  AssetsResetBundledAgentRuntime: core,
  AssetsListClaudeGatewayProfiles: core,
  AssetsListCodexModelProviders: core,

  LogsOpenDirectory: split,
  LogsReadToday: core,
  LogsTruncateToday: core,
  PreloadFatalError: clientHost,
} as const satisfies Record<CurrentApiMethod, CurrentApiClassification>;
