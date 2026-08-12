import { adapterRegistry } from '@main/adapters/registry';
import { buildCreateSessionOptions, type AgentId } from '@main/adapters/options-builder';
import {
  firstUnsupportedTargetRuntimeField,
  unsupportedTargetRuntimeFieldMessage,
} from '@main/adapters/runtime-control-contracts';
import {
  resolveCreateSessionModelOptions,
  SessionModelOptionsError,
} from '@main/adapters/session-model-options';
import { sessionManager } from '@main/session/manager';
import { deleteUploadIfExists } from '@main/store/image-uploads';
import log from '@main/utils/logger';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { persistAdapterAttachments } from './adapters-attachments';
import {
  IpcInputError,
  parseAdapterSessionMode,
  parseCodexApprovalPolicy,
  parseCodexSandboxMode,
  parseGrokSandboxProfile,
  parsePermissionMode,
  parseSandboxMode,
  parseStringId,
} from './_helpers';

const logger = log.scope('ipc-issue-resolution-session');

interface CreateIssueResolutionSessionInput {
  adapter: string;
  cwd: string;
  prompt: string;
  attachments?: unknown;
  permissionMode: ReturnType<typeof parsePermissionMode>;
  sessionMode?: ReturnType<typeof parseAdapterSessionMode>;
  approvalPolicy?: ReturnType<typeof parseCodexApprovalPolicy>;
  codexSandbox: ReturnType<typeof parseCodexSandboxMode>;
  claudeCodeSandbox: ReturnType<typeof parseSandboxMode>;
  grokSandbox?: ReturnType<typeof parseGrokSandboxProfile>;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
}

/** Create one Local Issue resolution session through the normal bounded adapter boundary. */
export async function createIssueResolutionSession(
  input: CreateIssueResolutionSessionInput,
): Promise<string> {
  const validAdapterId = parseStringId('adapter', input.adapter, 64);
  const adapter = adapterRegistry.get(validAdapterId);
  if (!adapter) {
    throw new IpcInputError('adapter', `adapter "${validAdapterId}" not found in registry`);
  }
  if (!adapter.createSession) {
    throw new IpcInputError('adapter', `adapter "${validAdapterId}" does not implement createSession`);
  }
  if (adapter.capabilities.canCreateSession !== true) {
    throw new IpcInputError(
      'adapter', `adapter "${validAdapterId}" capabilities.canCreateSession=false`,
    );
  }
  const approvalPolicy = input.approvalPolicy ?? null;
  if (approvalPolicy !== null && validAdapterId !== 'codex-cli') {
    throw new IpcInputError(
      'approvalPolicy',
      `owned by codex-cli and incompatible with target adapter "${validAdapterId}"`,
    );
  }
  const unsupportedRuntimeField = firstUnsupportedTargetRuntimeField(
    validAdapterId as AgentId,
    {
      ...(input.permissionMode !== null ? { permissionMode: input.permissionMode } : {}),
      ...(input.sessionMode != null ? { sessionMode: input.sessionMode } : {}),
      ...(input.codexSandbox !== null ? { codexSandbox: input.codexSandbox } : {}),
      ...(input.claudeCodeSandbox !== null
        ? { claudeCodeSandbox: input.claudeCodeSandbox } : {}),
      ...(input.grokSandbox != null ? { grokSandbox: input.grokSandbox } : {}),
    },
  );
  if (unsupportedRuntimeField !== null) {
    throw new IpcInputError(
      unsupportedRuntimeField,
      unsupportedTargetRuntimeFieldMessage(validAdapterId as AgentId, unsupportedRuntimeField),
    );
  }
  if (input.sessionMode != null && !adapter.capabilities.canSetSessionMode) {
    throw new IpcInputError(
      'sessionMode',
      `adapter "${validAdapterId}" does not support session mode "${input.sessionMode}"`,
    );
  }
  if (input.prompt.length > MAX_USER_MESSAGE_LENGTH) {
    throw new IpcInputError(
      'prompt', `> 102400 chars (got ${input.prompt.length.toLocaleString()} chars)`,
    );
  }
  if (input.cwd.length > 4096) {
    throw new IpcInputError('cwd', `length > 4096 (got ${input.cwd.length})`);
  }
  let modelOptions;
  try {
    modelOptions = resolveCreateSessionModelOptions(validAdapterId as AgentId, {
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
    });
  } catch (error) {
    if (error instanceof SessionModelOptionsError) {
      throw new IpcInputError(error.field, error.message);
    }
    throw error;
  }
  if (Array.isArray(input.attachments) && input.attachments.length > 0
      && adapter.capabilities.canAcceptAttachments !== true) {
    throw new IpcInputError(
      'attachments', `adapter "${validAdapterId}" does not support attachments`,
    );
  }
  const attachments = await persistAdapterAttachments(input.attachments, 'attachments');
  const createOptions = buildCreateSessionOptions(validAdapterId, {
    cwd: input.cwd,
    prompt: input.prompt,
    ...(input.permissionMode !== null ? { permissionMode: input.permissionMode } : {}),
    ...(input.sessionMode != null ? { sessionMode: input.sessionMode } : {}),
    ...(input.codexSandbox !== null ? { codexSandbox: input.codexSandbox } : {}),
    ...(input.claudeCodeSandbox !== null
      ? { claudeCodeSandbox: input.claudeCodeSandbox } : {}),
    ...(input.grokSandbox != null ? { grokSandbox: input.grokSandbox } : {}),
    ...modelOptions,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  if (createOptions.agentId === 'codex-cli' && approvalPolicy !== null) {
    createOptions.approvalPolicy = approvalPolicy;
  }
  let sessionId: string;
  try {
    sessionId = await adapter.createSession(createOptions);
  } catch (error) {
    await Promise.all(attachments.map((attachment) => deleteUploadIfExists(attachment.path)));
    throw error;
  }
  if (input.permissionMode !== null && adapter.capabilities.canSetPermissionMode) {
    try {
      sessionManager.recordCreatedPermissionMode(sessionId, input.permissionMode);
    } catch (error) {
      logger.warn(`recordCreatedPermissionMode(${sessionId}) failed`, error);
    }
  }
  return sessionId;
}
