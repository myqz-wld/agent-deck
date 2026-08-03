import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';

export type CodexThreadMode =
  | { mode: 'start'; options: CodexThreadOptions }
  | { mode: 'resume'; threadId: string; options: CodexThreadOptions };

function withOptions(
  mode: CodexThreadMode,
  options: CodexThreadOptions,
): CodexThreadMode {
  return mode.mode === 'resume'
    ? { mode: 'resume', threadId: mode.threadId, options }
    : { mode: 'start', options };
}

export function withSandboxMode(
  mode: CodexThreadMode,
  sandboxMode: CodexThreadOptions['sandboxMode'],
  opts: {
    networkAccessEnabled?: boolean;
    additionalDirectories?: readonly string[];
  },
): CodexThreadMode {
  return withOptions(mode, {
    ...mode.options,
    sandboxMode,
    ...(opts.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: opts.networkAccessEnabled }
      : {}),
    ...(opts.additionalDirectories !== undefined
      ? { additionalDirectories: [...opts.additionalDirectories] }
      : {}),
  });
}

export function withWorkingDirectory(
  mode: CodexThreadMode,
  workingDirectory: string,
): CodexThreadMode {
  return withOptions(mode, { ...mode.options, workingDirectory });
}

export function withApprovalPolicy(
  mode: CodexThreadMode,
  approvalPolicy: CodexThreadOptions['approvalPolicy'] | null,
): CodexThreadMode {
  const options = { ...mode.options };
  if (approvalPolicy === null) delete options.approvalPolicy;
  else options.approvalPolicy = approvalPolicy;
  return withOptions(mode, options);
}

export function withModelOptions(
  mode: CodexThreadMode,
  model: CodexThreadOptions['model'] | null,
  effort: CodexThreadOptions['modelReasoningEffort'] | null,
): CodexThreadMode {
  const options = { ...mode.options };
  if (model === null) delete options.model;
  else options.model = model;
  if (effort === null) delete options.modelReasoningEffort;
  else options.modelReasoningEffort = effort;
  return withOptions(mode, options);
}
